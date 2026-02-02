# LAN9662 CBS Real-time Dashboard

Apple-style UI + 실시간 CBS 테스트/검증 대시보드.

## 구성
- `cbs_dashboard_rt/` : 서버 + 웹 UI

## 요구사항
- `traffic-generator` (txgen/rxcap) 빌드됨
- `keti-tsn-cli` 설정 완료 및 `/dev/ttyACM0` 연결
- Root 권한 필요 (raw socket)

## 실행
```bash
# 서버 실행
sudo python3 /home/kim/lan9662-02-02/cbs_dashboard_rt/cbs_rt_server.py

# 브라우저
http://localhost:8010
```

## 사용 순서
1) Apply CBS
2) Start

## 참고
- 기본 TX는 TC별 10 Mbps 고정 (pps + per-packet delay)
- Idle-slope 기본값: TC0~TC7 = 1~8 Mbps
