#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import threading
import time
import shutil
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Queue, Empty
from collections import deque

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CSV_PATH = Path("/home/kim/tsn_results/cbs_rx.csv")
PATCH_DIR = Path("/home/kim/cbs_dashboard_rt/tmp")
TX_STATS_DIR = Path("/home/kim/tsn_results/tx_stats")
KETI_CLI = Path("/home/kim/keti-tsn-cli/keti-tsn")
DEVICE = "/dev/ttyACM0"
CAP_LINES_MAX = 40

state = {
    "running": False,
    "cfg": None,
    "rx_proc": None,
    "tx_proc": None,
    "tx_procs": [],
    "cap_proc": None,
    "cap_lines": deque(maxlen=CAP_LINES_MAX),
    "cap_mode": "none",
    "stop_event": threading.Event(),
}

broadcast_queue = Queue()


def run_cmd(cmd, check=True):
    result = subprocess.run(cmd, shell=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"Command failed: {cmd}")


def write_patch(path, content):
    Path(path).write_text(content)


def apply_board_config(cfg):
    vlan = cfg["vlan_id"]
    egress_port = cfg["egress_port"]
    ingress_port = cfg["ingress_port"]

    vlan_patch = f"""
- ? \"/ietf-interfaces:interfaces/interface[name='{egress_port}']/ieee802-dot1q-bridge:bridge-port/port-type\"
  : ieee802-dot1q-bridge:c-vlan-bridge-port
- ? \"/ietf-interfaces:interfaces/interface[name='{ingress_port}']/ieee802-dot1q-bridge:bridge-port/port-type\"
  : ieee802-dot1q-bridge:c-vlan-bridge-port
- ? \"/ietf-interfaces:interfaces/interface[name='{egress_port}']/ieee802-dot1q-bridge:bridge-port/acceptable-frame\"
  : admit-only-VLAN-tagged-frames
- ? \"/ietf-interfaces:interfaces/interface[name='{ingress_port}']/ieee802-dot1q-bridge:bridge-port/acceptable-frame\"
  : admit-only-VLAN-tagged-frames
- ? \"/ietf-interfaces:interfaces/interface[name='{egress_port}']/ieee802-dot1q-bridge:bridge-port/enable-ingress-filtering\"
  : true
- ? \"/ietf-interfaces:interfaces/interface[name='{ingress_port}']/ieee802-dot1q-bridge:bridge-port/enable-ingress-filtering\"
  : true
- ? \"/ieee802-dot1q-bridge:bridges/bridge[name='b0']/component[name='c0']/filtering-database/vlan-registration-entry\"
  : database-id: 0
    vids: '{vlan}'
    entry-type: static
    port-map:
      - port-ref: {egress_port}
        static-vlan-registration-entries:
          vlan-transmitted: tagged
      - port-ref: {ingress_port}
        static-vlan-registration-entries:
          vlan-transmitted: tagged
"""

    # PCP decoding/encoding identity map (8P0D)
    pcp_patch = f"""
- ? "/ietf-interfaces:interfaces/interface[name='{ingress_port}']/ieee802-dot1q-bridge:bridge-port/pcp-decoding-table/pcp-decoding-map"
  : pcp: 8P0D
- "/ietf-interfaces:interfaces/interface[name='{ingress_port}']/ieee802-dot1q-bridge:bridge-port/pcp-decoding-table/pcp-decoding-map[pcp='8P0D']/priority-map":
  - priority-code-point: 0
    priority: 0
    drop-eligible: false
  - priority-code-point: 1
    priority: 1
    drop-eligible: false
  - priority-code-point: 2
    priority: 2
    drop-eligible: false
  - priority-code-point: 3
    priority: 3
    drop-eligible: false
  - priority-code-point: 4
    priority: 4
    drop-eligible: false
  - priority-code-point: 5
    priority: 5
    drop-eligible: false
  - priority-code-point: 6
    priority: 6
    drop-eligible: false
  - priority-code-point: 7
    priority: 7
    drop-eligible: false

- ? "/ietf-interfaces:interfaces/interface[name='{egress_port}']/ieee802-dot1q-bridge:bridge-port/pcp-encoding-table/pcp-encoding-map"
  : pcp: 8P0D
- "/ietf-interfaces:interfaces/interface[name='{egress_port}']/ieee802-dot1q-bridge:bridge-port/pcp-encoding-table/pcp-encoding-map[pcp='8P0D']/priority-map":
  - priority: 0
    dei: false
    priority-code-point: 0
  - priority: 1
    dei: false
    priority-code-point: 1
  - priority: 2
    dei: false
    priority-code-point: 2
  - priority: 3
    dei: false
    priority-code-point: 3
  - priority: 4
    dei: false
    priority-code-point: 4
  - priority: 5
    dei: false
    priority-code-point: 5
  - priority: 6
    dei: false
    priority-code-point: 6
  - priority: 7
    dei: false
    priority-code-point: 7
"""

    cbs_entries = []
    for tc, slope in enumerate(cfg["idle_slope_kbps"]):
        cbs_entries.append(f"  - traffic-class: {tc}\n    credit-based:\n      idle-slope: {int(slope)}")
    cbs_patch = f"""
- "/ietf-interfaces:interfaces/interface[name='{egress_port}']/mchp-velocitysp-port:eth-qos/config/traffic-class-shapers":
{os.linesep.join(cbs_entries)}
"""

    PATCH_DIR.mkdir(parents=True, exist_ok=True)
    vlan_patch_file = str(PATCH_DIR / "cbs_vlan_patch.yaml")
    pcp_patch_file = str(PATCH_DIR / "cbs_pcp_patch.yaml")
    cbs_patch_file = str(PATCH_DIR / "cbs_idle_patch.yaml")
    write_patch(vlan_patch_file, vlan_patch)
    write_patch(pcp_patch_file, pcp_patch)
    write_patch(cbs_patch_file, cbs_patch)

    run_cmd(f"sudo {KETI_CLI} patch {vlan_patch_file} -d {DEVICE}")
    run_cmd(f"sudo {KETI_CLI} patch {pcp_patch_file} -d {DEVICE}")
    run_cmd(f"sudo {KETI_CLI} patch {cbs_patch_file} -d {DEVICE}")

def optimize_system():
    cmds = [
        "bash -c \"for c in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance > $c 2>/dev/null || true; done\"",
        "bash -c \"echo -1 > /sys/module/usbcore/parameters/autosuspend 2>/dev/null || true\"",
    ]
    for cmd in cmds:
        run_cmd(f"sudo {cmd}", check=False)


def setup_pc_vlan(cfg):
    vlan = cfg["vlan_id"]
    ingress_if = cfg["ingress_iface"]
    egress_if = cfg["egress_iface"]
    cmd = (
        f"ip link del vlan{vlan} 2>/dev/null || true; "
        f"ip link del vlan{vlan}b 2>/dev/null || true; "
        f"ip link add link {ingress_if} name vlan{vlan} type vlan id {vlan}; "
        f"ip link add link {egress_if} name vlan{vlan}b type vlan id {vlan}; "
        f"ip addr add 10.0.{vlan}.1/24 dev vlan{vlan}; "
        f"ip addr add 10.0.{vlan}.2/24 dev vlan{vlan}b; "
        f"ip link set vlan{vlan} up; ip link set vlan{vlan}b up; "
        f"ip link set dev vlan{vlan} type vlan egress-qos-map 0:0 1:1 2:2 3:3 4:4 5:5 6:6 7:7"
    )
    run_cmd(f"sudo bash -c \"{cmd}\"")


def start_test(cfg):
    if state["running"]:
        return
    state["running"] = True
    state["cfg"] = cfg
    state["stop_event"].clear()
    # Apply config only if requested or not applied yet
    use_board = cfg.get("use_board", True)
    if not use_board:
        mac = read_iface_mac(cfg["egress_iface"])
        if mac:
            cfg["dst_mac"] = mac
    if use_board and not Path(DEVICE).exists():
        use_board = False
    if use_board and (cfg.get("apply_first", False) or not state.get("applied")):
        try:
            apply_board_config(cfg)
            setup_pc_vlan(cfg)
            state["applied"] = True
        except Exception:
            state["applied"] = False

    optimize_system()

    # Start rxcap
    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    if CSV_PATH.exists():
        CSV_PATH.unlink()

    # Prepare tx stats files
    TX_STATS_DIR.mkdir(parents=True, exist_ok=True)
    for tc in range(8):
        p = TX_STATS_DIR / f"tx_tc{tc}.csv"
        if p.exists():
            p.unlink()

    seq_only_flag = "--seq-only " if cfg.get("rx_seq_only", True) else ""
    rx_cmd = (
        f"sudo taskset -c {cfg['rx_cpu']} /home/kim/traffic-generator/rxcap {cfg['egress_iface']} "
        f"--seq --pcp-stats {seq_only_flag}--dst-mac {cfg['dst_mac']} --duration {cfg['duration'] + 2} --batch {cfg['rx_batch']} "
        f"--csv {CSV_PATH}"
    )
    state["rx_proc"] = subprocess.Popen(rx_cmd, shell=True)

    start_capture(cfg)

    # Start txgen per TC (constant per-TC rate, stable stats)
    rate_per_tc = cfg["rate_per_tc_mbps"]
    if rate_per_tc <= 0:
        rate_per_tc = 10
    if cfg["tx_batch"] < 1:
        cfg["tx_batch"] = 1
    state["tx_procs"] = []
    for tc in range(8):
        tx_cmd = (
            f"sudo taskset -c {cfg['tx_cpu']} /home/kim/traffic-generator/txgen {cfg['ingress_iface']} "
            f"-B {cfg['dst_ip']} -b {cfg['dst_mac']} -Q {tc}:{cfg['vlan_id']} "
            f"--seq -r {rate_per_tc} --duration {cfg['duration']} "
            f"-l {cfg['packet_size']} --batch {cfg['tx_batch']} "
            f"--stats-file {TX_STATS_DIR}/tx_stats_tc{tc}.csv"
        )
        state["tx_procs"].append(subprocess.Popen(tx_cmd, shell=True))

    threading.Thread(target=csv_watcher, daemon=True).start()
    threading.Thread(target=wait_for_completion, daemon=True).start()


def wait_for_completion():
    tx = state.get("tx_proc")
    rx = state.get("rx_proc")
    if tx:
        tx.wait()
    if state.get("tx_procs"):
        for p in state["tx_procs"]:
            p.wait()
    if rx:
        rx.wait()
    state["running"] = False


def stop_test():
    state["stop_event"].set()
    for key in ("tx_proc", "rx_proc"):
        proc = state.get(key)
        if proc and proc.poll() is None:
            try:
                proc.send_signal(signal.SIGINT)
            except Exception:
                pass
    if state.get("tx_procs"):
        for p in state["tx_procs"]:
            if p and p.poll() is None:
                try:
                    p.send_signal(signal.SIGINT)
                except Exception:
                    pass
    cap = state.get("cap_proc")
    if cap and cap.poll() is None:
        try:
            cap.send_signal(signal.SIGINT)
        except Exception:
            pass
    state["running"] = False


def start_capture(cfg):
    state["cap_lines"].clear()
    iface = cfg["egress_iface"]
    dst_mac = cfg["dst_mac"].lower()
    cap_filter = cfg.get("capture_filter", "dst")
    if shutil.which("tshark"):
        state["cap_mode"] = "tshark"
        filter_expr = f"ether dst {dst_mac}" if cap_filter == "dst" else ""
        cmd = (
            f"sudo tshark -l -i {iface} "
            + (f"-f \"{filter_expr}\" " if filter_expr else "")
            + "-T fields -E separator=, -E quote=d "
            + "-e frame.time_relative -e frame.len -e eth.src -e eth.dst "
            + "-e vlan.id -e vlan.prio -e ip.src -e ip.dst -e udp.srcport -e udp.dstport"
        )
        state["cap_proc"] = subprocess.Popen(
            cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
        )
        threading.Thread(target=capture_reader, daemon=True).start()
    elif shutil.which("tcpdump"):
        state["cap_mode"] = "tcpdump"
        filter_expr = f"ether dst {dst_mac}" if cap_filter == "dst" else ""
        cmd = (
            f"sudo tcpdump -l -n -e -tt -i {iface} "
            + (filter_expr if filter_expr else "")
        )
        state["cap_proc"] = subprocess.Popen(
            cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
        )
        threading.Thread(target=capture_reader, daemon=True).start()
    else:
        state["cap_mode"] = "none"


def capture_reader():
    proc = state.get("cap_proc")
    if not proc or not proc.stdout:
        return
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        state["cap_lines"].append(line)
        if state["stop_event"].is_set():
            break


def read_iface_stats(iface):
    base = Path(f"/sys/class/net/{iface}/statistics")
    def read_int(name):
        p = base / name
        try:
            return int(p.read_text().strip())
        except Exception:
            return 0
    return {
        "rx_packets": read_int("rx_packets"),
        "rx_bytes": read_int("rx_bytes"),
        "rx_dropped": read_int("rx_dropped"),
        "rx_errors": read_int("rx_errors"),
        "tx_packets": read_int("tx_packets"),
        "tx_bytes": read_int("tx_bytes"),
        "tx_dropped": read_int("tx_dropped"),
        "tx_errors": read_int("tx_errors"),
    }


def read_iface_mac(iface):
    try:
        return (Path(f"/sys/class/net/{iface}/address").read_text().strip() or "").lower()
    except Exception:
        return ""


def csv_watcher():
    last = None
    last_valid = None
    pkt_size = state["cfg"]["packet_size"]
    tolerance = state["cfg"]["tolerance"]
    idle = state["cfg"]["idle_slope_kbps"]
    smooth = int(state["cfg"].get("smooth_window", 5))
    tc_windows = [deque(maxlen=max(1, smooth)) for _ in range(8)]
    tx_windows = [deque(maxlen=max(1, smooth)) for _ in range(8)]
    iface_last = read_iface_stats(state["cfg"]["egress_iface"])
    ingress_last = read_iface_stats(state["cfg"]["ingress_iface"])

    pps_floor = 1000.0
    min_time_s = 2.0
    while not state["stop_event"].is_set() and state["running"]:
        if CSV_PATH.exists():
            lines = CSV_PATH.read_text().strip().splitlines()
            if len(lines) >= 2:
                header = lines[0].split(",")
                row = lines[-1].split(",")
                curr = dict(zip(header, row))

                if last:
                    dt = float(curr["time_s"]) - float(last["time_s"])
                    if dt <= 0:
                        dt = 1.0
                    per_tc_mbps = []
                    per_tc_mbps_scaled = []
                    pred_mbps = []
                    pass_list = []
                    tx_tc_mbps = []
                    exp_mbps = []
                    delta_total = int(curr["total_pkts"]) - int(last["total_pkts"])
                    bytes_per_pkt = pkt_size
                    total_mbps_pcp = 0.0
                    total_mbps_rxcap = float(curr["total_mbps"])
                    total_mbps_calc = 0.0
                    vlan_pkts = int(curr.get("vlan_pkts", 0)) if "vlan_pkts" in curr else 0
                    non_vlan_pkts = int(curr.get("non_vlan_pkts", 0)) if "non_vlan_pkts" in curr else 0
                    seq_pkts = int(curr.get("seq_pkts", 0)) if "seq_pkts" in curr else 0
                    emb_pcp_pkts = int(curr.get("embedded_pcp_pkts", 0)) if "embedded_pcp_pkts" in curr else 0
                    last_emb_pcp = int(last.get("embedded_pcp_pkts", 0)) if "embedded_pcp_pkts" in last else 0
                    delta_emb_pcp = max(0, emb_pcp_pkts - last_emb_pcp)

                    # Read tx stats (if available)
                    for tc in range(8):
                        tx_file = TX_STATS_DIR / f"tx_stats_tc{tc}.csv"
                        alt_file = TX_STATS_DIR / f"tx_stats.csv.tc{tc}"
                        if not tx_file.exists() and alt_file.exists():
                            tx_file = alt_file
                        tx_mbps = 0.0
                        if tx_file.exists():
                            try:
                                lines = tx_file.read_text().strip().splitlines()
                                if len(lines) >= 2:
                                    last_tx = lines[-1].split(",")
                                    # time,packets,bytes,pps,mbps,errors
                                    tx_mbps = float(last_tx[4])
                            except Exception:
                                tx_mbps = 0.0
                        tx_windows[tc].append(tx_mbps)
                        tx_tc_mbps.append(sum(tx_windows[tc]) / len(tx_windows[tc]))
                    # Derive effective packet size from rxcap total if possible
                    pkt_size_eff = bytes_per_pkt
                    if dt > 0 and delta_total > 0 and total_mbps_rxcap > 0:
                        pkt_size_eff = (total_mbps_rxcap * 1_000_000 * dt / 8) / delta_total

                    sum_pcp_delta = 0
                    for tc in range(8):
                        key = f"pcp{tc}_pkts"
                        dp = int(curr[key]) - int(last[key])
                        sum_pcp_delta += max(0, dp)
                        if dt > 0:
                            mbps = (dp * pkt_size_eff * 8) / (dt * 1_000_000)
                        else:
                            mbps = 0.0
                        tc_windows[tc].append(mbps)
                        avg = sum(tc_windows[tc]) / len(tc_windows[tc])
                        per_tc_mbps.append(avg)
                        total_mbps_pcp += avg
                        pred = idle[tc] / 1000.0
                        pred_mbps.append(pred)
                        expected = min(pred, tx_tc_mbps[tc]) if tx_tc_mbps[tc] > 0 else pred
                        exp_mbps.append(expected)
                        diff = abs(avg - expected) / expected if expected > 0 else 0
                        pass_list.append(diff <= tolerance)

                    iface_now = read_iface_stats(state["cfg"]["egress_iface"])
                    ingress_now = read_iface_stats(state["cfg"]["ingress_iface"])
                    def delta(now, prev):
                        return max(0, now - prev)
                    iface_delta = {k: delta(iface_now[k], iface_last[k]) for k in iface_now}
                    ingress_delta = {k: delta(ingress_now[k], ingress_last[k]) for k in ingress_now}
                    iface_last = iface_now
                    ingress_last = ingress_now

                    if total_mbps_rxcap > 0:
                        total_mbps_calc = total_mbps_rxcap
                    elif dt > 0:
                        total_mbps_calc = (delta_total * pkt_size_eff * 8) / (dt * 1_000_000)
                    total_pred = sum(pred_mbps)
                    total_tx = sum(tx_tc_mbps)
                    rx_ratio = (total_mbps_calc / total_pred) if total_pred > 0 else 0.0
                    pcp_ratio = (total_mbps_pcp / total_mbps_calc) if total_mbps_calc > 0 else 0.0
                    # Use embedded PCP packet deltas when available to avoid 0/100% oscillation.
                    if delta_total > 0 and delta_emb_pcp > 0:
                        pcp_ratio_count = (delta_emb_pcp / delta_total)
                    elif delta_total > 0:
                        pcp_ratio_count = (sum_pcp_delta / delta_total)
                    else:
                        pcp_ratio_count = 0.0
                    # Freeze ratio when packet count is too low for a stable estimate.
                    min_pkts = max(int(pps_floor * dt), 100)
                    if delta_total < min_pkts and last_valid:
                        pcp_ratio_count = last_valid.get("pcp_ratio_count", pcp_ratio_count)
                    unknown_mbps = max(0.0, total_mbps_calc - total_mbps_pcp)
                    scale = (total_mbps_calc / total_mbps_pcp) if total_mbps_pcp > 0 else 0.0
                    per_tc_mbps_scaled = [v * scale for v in per_tc_mbps]

                    payload = {
                        "time_s": float(curr["time_s"]),
                        "total_mbps": total_mbps_rxcap,
                        "total_mbps_calc": total_mbps_calc,
                        "total_mbps_pcp": total_mbps_pcp,
                        "unknown_mbps": unknown_mbps,
                        "pkt_size_eff": pkt_size_eff,
                        "pps_floor": pps_floor,
                        "total_pps": float(curr["total_pps"]),
                        "drops": int(curr["drops"]),
                        "total_pkts": int(curr["total_pkts"]),
                        "pcp_pkts": [int(curr[f"pcp{i}_pkts"]) for i in range(8)],
                        "vlan_pkts": vlan_pkts,
                        "non_vlan_pkts": non_vlan_pkts,
                        "seq_pkts": seq_pkts,
                        "embedded_pcp_pkts": emb_pcp_pkts,
                        "per_tc_mbps": per_tc_mbps,
                        "per_tc_mbps_scaled": per_tc_mbps_scaled,
                        "pred_mbps": pred_mbps,
                        "tx_tc_mbps": tx_tc_mbps,
                        "exp_mbps": exp_mbps,
                        "pass": pass_list,
                        "cap_mode": state.get("cap_mode", "none"),
                        "cap_lines": list(state["cap_lines"]),
                        "iface_delta": iface_delta,
                        "ingress_delta": ingress_delta,
                        "rx_ratio": rx_ratio,
                        "pcp_ratio": pcp_ratio,
                        "pcp_ratio_count": pcp_ratio_count,
                        "total_pred": total_pred,
                        "total_tx": total_tx,
                    }
                    if float(curr["time_s"]) >= min_time_s and float(curr["total_pps"]) >= pps_floor:
                        last_valid = payload
                        broadcast_queue.put(payload)
                    elif last_valid:
                        broadcast_queue.put(last_valid)

                last = curr
        time.sleep(0.5)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.endswith(".js") or self.path.endswith(".html") or self.path.endswith(".css") or self.path == "/":
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/events":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            while True:
                try:
                    data = broadcast_queue.get(timeout=5)
                    msg = f"data: {json.dumps(data)}\n\n"
                    self.wfile.write(msg.encode("utf-8"))
                    self.wfile.flush()
                except Empty:
                    try:
                        self.wfile.write(b": keep-alive\n\n")
                        self.wfile.flush()
                    except Exception:
                        break
                except Exception:
                    break
            return

        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        data = json.loads(body)

        if self.path == "/start":
            cfg = {
                "ingress_iface": data.get("ingress_iface", "enx00e04c6812d1"),
                "egress_iface": data.get("egress_iface", "enxc84d44263ba6"),
                "dst_mac": data.get("dst_mac", "c8:4d:44:26:3b:a6"),
                "vlan_id": int(data.get("vlan_id", 100)),
                "duration": int(data.get("duration", 20)),
                "packet_size": int(data.get("packet_size", 512)),
                "rate_per_tc_mbps": int(data.get("rate_per_tc_mbps", 60)),
                "idle_slope_kbps": data.get("idle_slope_kbps", [5000]*8),
                "tolerance": float(data.get("tolerance", 0.1)),
                "smooth_window": int(data.get("smooth_window", 5)),
                "rx_batch": int(data.get("rx_batch", 512)),
                "tx_batch": int(data.get("tx_batch", 1024)),
                "rx_cpu": int(data.get("rx_cpu", 2)),
                "tx_cpu": int(data.get("tx_cpu", 3)),
                "egress_port": str(data.get("egress_port", "1")),
                "ingress_port": str(data.get("ingress_port", "2")),
                "dst_ip": data.get("dst_ip", "10.0.100.2"),
                "apply_first": bool(data.get("apply_first", False)),
                "use_board": bool(data.get("use_board", True)),
                "capture_filter": data.get("capture_filter", "dst"),
                "rx_seq_only": bool(data.get("rx_seq_only", True)),
            }
            try:
                start_test(cfg)
                self.send_response(HTTPStatus.OK)
                self.end_headers()
                self.wfile.write(b"ok")
            except Exception as e:
                self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
                self.end_headers()
                self.wfile.write(str(e).encode("utf-8"))
            return

        if self.path == "/apply":
            cfg = {
                "ingress_iface": data.get("ingress_iface", "enx00e04c6812d1"),
                "egress_iface": data.get("egress_iface", "enxc84d44263ba6"),
                "dst_mac": data.get("dst_mac", "c8:4d:44:26:3b:a6"),
                "vlan_id": int(data.get("vlan_id", 100)),
                "duration": int(data.get("duration", 20)),
                "packet_size": int(data.get("packet_size", 512)),
                "rate_per_tc_mbps": int(data.get("rate_per_tc_mbps", 60)),
                "idle_slope_kbps": data.get("idle_slope_kbps", [5000]*8),
                "tolerance": float(data.get("tolerance", 0.1)),
                "smooth_window": int(data.get("smooth_window", 5)),
                "rx_batch": int(data.get("rx_batch", 512)),
                "tx_batch": int(data.get("tx_batch", 1024)),
                "rx_cpu": int(data.get("rx_cpu", 2)),
                "tx_cpu": int(data.get("tx_cpu", 3)),
                "egress_port": str(data.get("egress_port", "1")),
                "ingress_port": str(data.get("ingress_port", "2")),
                "dst_ip": data.get("dst_ip", "10.0.100.2"),
                "capture_filter": data.get("capture_filter", "dst"),
                "rx_seq_only": bool(data.get("rx_seq_only", True)),
            }
            try:
                if not Path(DEVICE).exists():
                    raise RuntimeError(f"Device not found: {DEVICE}")
                apply_board_config(cfg)
                setup_pc_vlan(cfg)
                state["applied"] = True
                self.send_response(HTTPStatus.OK)
                self.end_headers()
                self.wfile.write(b"ok")
            except Exception as e:
                self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
                self.end_headers()
                self.wfile.write(str(e).encode("utf-8"))
            return

        if self.path == "/stop":
            stop_test()
            self.send_response(HTTPStatus.OK)
            self.end_headers()
            self.wfile.write(b"ok")
            return

        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()


if __name__ == "__main__":
    os.chdir(STATIC)
    server = ThreadingHTTPServer(("0.0.0.0", 8010), Handler)
    print("CBS RT server listening on http://localhost:8010")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
