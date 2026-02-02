# LAN9662 CBS Real-time Dashboard

실시간 CBS 테스트/검증 대시보드. LAN9662 보드 경로와 PC 직결(Direct) 경로를 모두 지원한다.

## 구성
- `cbs_dashboard_rt/` : 서버 + 웹 UI

## 요구사항
- `traffic-generator` (txgen/rxcap) 빌드됨
- `keti-tsn-cli` 설정 완료 및 `/dev/ttyACM0` 연결 (보드 사용 시)
- Root 권한 필요 (raw socket)

## 실행
```bash
# 서버 실행
sudo python3 /home/kim/lan9662-02-02/cbs_dashboard_rt/cbs_rt_server.py

# 브라우저
http://localhost:8010
```

## 사용 순서
1) Use Board (apply CBS)
   - **Yes**: 보드 설정 적용 후 테스트
   - **No (direct)**: 보드 없이 USB NIC 직결 테스트
2) Apply CBS (보드 모드일 때만)
3) Start

## 수치/지표 설명
### 총합 지표
- **Total RX Mbps (Calc)**: rxcap의 `total_mbps` 값을 그대로 표시. 전체 수신 속도의 기준값.
- **Raw RX Mbps (rxcap)**: 동일 값(디버깅용). Calc와 Raw가 다르면 서버가 최신 코드로 안 올라간 상태일 수 있음.
- **PCP Sum Mbps**: PCP0~7 델타 합으로 계산한 수신 합계.
- **Unknown PCP Mbps**: `Total RX - PCP Sum`. PCP 분류가 안 되는 트래픽량.
- **PCP Coverage**: `PCP Sum / Total RX`. 50%면 절반이 PCP로 분류되지 않음.
- **PPS Floor**: 저속 샘플을 버리는 임계값(기본 1000pps).

### Per-TC Validation
- **TX (Mbps)**: 각 TC별 txgen 송신 속도.
- **RX (Mbps)**: PCP Coverage가 낮을 경우 자동 스케일된 TC별 수신값.
- **Pred (Mbps)**: idle-slope 기준 예측치.
- **Error %**: `(RX - Pred) / Pred` 절대값.

### 그래프/표
- **Total Throughput (RX vs TX)**: 총합 RX/TX 추이 비교.
- **Interface Deltas**: 구간별 인터페이스 RX/TX 카운터 변화(드롭/에러 포함).
- **TX/RX Samples**: 구간 요약.
- **Live Packet List**: `tshark` 기반 실시간 패킷 리스트.
  - 비어 있으면 캡처 필터/PCP/VID가 맞지 않거나 트래픽 없음.

## 참고/제약
- 기본 TX는 TC별 10 Mbps 고정.
- Idle-slope 기본값: TC0~TC7 = 1~8 Mbps.
- 직결 테스트는 **Use Board = No**로 실행.
- 보드 경로에서 PCP Coverage가 50%면, 절반의 패킷이 PCP 분류되지 않음을 의미.

## 보드 설정(문서화)
보드 모드(Use Board = Yes)에서 적용되는 설정은 아래와 같다.

### VLAN/포트
- 포트 1/2: `c-vlan-bridge-port`
- `acceptable-frame`: `admit-only-VLAN-tagged-frames`
- `enable-ingress-filtering`: `true`
- VLAN 100: 포트 1/2 tagged 등록

### PCP 디코딩/인코딩
- **Ingress(포트 2)**: PCP decoding map (PCP 0~7 → priority 0~7)
- **Egress(포트 1)**: PCP encoding map (priority 0~7 → PCP 0~7)

### CBS(traffic-class shapers)
- 포트 1, TC0~TC7에 idle-slope 적용
- 기본값: 1~8 Mbps (kbps 단위로 입력)

### 적용 경로
서버가 사용하는 YANG 경로(요약):
- VLAN/포트:  
  `/ietf-interfaces:interfaces/interface[name='X']/ieee802-dot1q-bridge:bridge-port/...`  
  `/ieee802-dot1q-bridge:bridges/bridge[name='b0']/component[name='c0']/filtering-database/vlan-registration-entry`
- PCP decoding:  
  `/ietf-interfaces:interfaces/interface[name='2']/ieee802-dot1q-bridge:bridge-port/pcp-decoding-table/...`
- PCP encoding:  
  `/ietf-interfaces:interfaces/interface[name='1']/ieee802-dot1q-bridge:bridge-port/pcp-encoding-table/...`
- CBS shaper:  
  `/ietf-interfaces:interfaces/interface[name='1']/mchp-velocitysp-port:eth-qos/config/traffic-class-shapers`

※ 보드 재부팅 직후 `lma_cc_keys_read()` 에러가 발생하면 patch가 모두 실패한다.  
이 경우 보드 준비가 끝난 뒤(Checksum OK) 다시 적용해야 한다.
