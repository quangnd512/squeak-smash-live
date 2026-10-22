# Squeak Smash! – bản chạy thật (backend + game)

Game xả stress miễn phí: người chơi **không cần tài khoản**, chỉ nhập tên và chọn quốc gia. Mỗi ván 60 giây, điểm được cộng vào tổng điểm của quốc gia trong tháng; đầu tháng (giờ UTC) bảng quốc gia về 0.

```
shared/game-core.js   Luật chơi + bộ sinh lịch chuột. Chạy Y HỆT trên trình duyệt và trên server.
shared/countries.json Danh sách quốc gia (ISO), tạo bằng scripts/gen-countries.js
server/               API Node.js (Fastify) + Postgres + Redis
public/index.html     Giao diện game (bản chạy thật, gọi API)
test/                 22 test: luật chơi, chống gian lận, API với Postgres/Redis thật, reset tháng
scripts/              backup, restore, admin, harden-vps, cloudflare-only
Dockerfile, docker-compose.yml, Caddyfile, .env.example
```

## 1. Cách hoạt động (để bạn nắm khi vận hành)

1. Người chơi nhập tên + quốc gia → server tạo một "khách" và trả về **mã bí mật** (trình duyệt tự lưu). Server chỉ lưu bản băm của mã. Không email, không mật khẩu.
2. Bấm chơi → server chọn **hạt giống ngẫu nhiên** và ghi lại giờ bắt đầu. Hạt giống quyết định toàn bộ chuột của ván (lỗ nào, loại nào, lúc nào), không phụ thuộc người chơi.
3. Trình duyệt chơi theo lịch đó và ghi lại **từng cú chạm** (thời điểm, lỗ).
4. Hết 60 giây, trình duyệt gửi nhật ký cú chạm. **Server chạy lại ván bằng đúng đoạn mã luật chơi và tự tính điểm.** Điểm do trình duyệt tự báo bị bỏ qua hoàn toàn.
5. Mỗi mã ván chỉ dùng được một lần, mỗi người chỉ có một ván đang mở, và không thể nộp sớm hơn 61 giây sau lúc bắt đầu.
6. Kiểm tra "giống người thật": phản xạ nhanh phi thực tế → **từ chối** (không tính điểm, bị ghi 1 gậy; đủ `MAX_STRIKES` gậy thì bị chặn); phản xạ đều tăm tắp hoặc chính xác gần tuyệt đối → **nghi ngờ** (vẫn tính điểm nhưng đánh dấu để bạn xem).

Điểm quốc gia = **tổng** điểm mọi ván của mọi người chơi trong tháng. Quốc gia cần ít nhất 1 người chơi trong tháng mới được xếp hạng. Bảng người chơi xếp theo **ván cao nhất** (mặc định tính mọi thời đại; đặt `PLAYERS_BOARD_SCOPE=month` để tính theo tháng).

Redis dùng cho: giới hạn tốc độ, ván đang mở. Bảng xếp hạng nằm trong Postgres (có index, đủ cho hàng trăm nghìn người chơi); khi lớn hơn mới cần chuyển sang Redis sorted set.

## 2. Chạy thử trên máy bạn (không cần domain)

Cách nhanh nhất là Docker:

```bash
cp .env.example .env
# sửa .env: DOMAIN=localhost, và đặt 3 mật khẩu bằng:  openssl rand -hex 24
docker compose up -d --build
# mở https://localhost  (trình duyệt sẽ cảnh báo chứng chỉ tự ký, bấm tiếp tục)
```

Không dùng Docker (cần Node 20+, Postgres 14+, Redis 6+ đang chạy):

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/squeak REDIS_URL=redis://localhost:6379 npm start
# mở http://localhost:3000
```

Chạy test (cần một Postgres + Redis chạy riêng, xem đầu file `scripts/test-env.sh`):

```bash
./scripts/test-env.sh
```

## 3. Đưa lên VPS GoDaddy

**Trước khi mua**, hỏi GoDaddy (chat/hotline) và xem bảng giá hiện tại:
- VPS có chạy được **Docker** không (nếu không: chọn nhà cung cấp VPS khác, hoặc cài Node/Postgres/Redis trực tiếp);
- chọn được **vị trí data center** không (gần người chơi chính, ví dụ Singapore hoặc Mỹ);
- giá **gia hạn** sau khuyến mãi, chính sách hoàn tiền, **băng thông** mỗi tháng, có **snapshot/backup** của nhà cung cấp không.

Chọn Ubuntu 22.04/24.04, tối thiểu 2 GB RAM.

**Bước 1 – Đăng nhập và bảo vệ máy chủ**
```bash
ssh root@IP_VPS
# trên máy bạn: ssh-copy-id root@IP_VPS   (thêm khóa SSH), thử đăng nhập bằng khóa ở cửa sổ thứ 2
# rồi trên VPS:
curl -fsSL https://get.docker.com | sh
```
Chép thư mục dự án lên VPS (ví dụ `scp -r squeak-smash-live root@IP_VPS:/opt/squeak-smash`), rồi:
```bash
cd /opt/squeak-smash
./scripts/harden-vps.sh      # tường lửa 22/80/443, fail2ban, tắt đăng nhập bằng mật khẩu, tự cập nhật bảo mật
```

**Bước 2 – Cấu hình**
```bash
cp .env.example .env && nano .env
```
Điền `DOMAIN`, 3 giá trị bí mật (dùng `openssl rand -hex 24`, đừng dùng base64 vì ký tự `/ + =` làm hỏng chuỗi kết nối). Trỏ bản ghi DNS **A** của domain (và `www`) về IP VPS.

**Bước 3 – Chạy**
```bash
docker compose up -d --build
docker compose ps            # 4 dịch vụ phải "running/healthy"
docker compose logs -f api   # xem log
```
Caddy tự xin chứng chỉ HTTPS miễn phí khi DNS đã trỏ đúng. Mở `https://domain-cua-ban`, chơi thử một ván trọn vẹn.

**Bước 4 – Cloudflare (khuyến nghị)**
1. Thêm domain vào Cloudflare (gói Free), đổi nameserver theo hướng dẫn, bật proxy (đám mây cam), SSL mode **Full (strict)**.
2. Tạo Turnstile (miễn phí) → điền `TURNSTILE_SITE_KEY` và `TURNSTILE_SECRET` vào `.env`.
3. Sau khi site chạy ổn qua Cloudflare: `./scripts/cloudflare-only.sh`, đặt `BEHIND_CLOUDFLARE=true` trong `.env`, rồi `docker compose up -d`. Việc này chặn mọi truy cập trực tiếp vào IP máy chủ, nên không ai giả được IP người chơi để né giới hạn tốc độ. Kiểm tra bằng lệnh in ra ở cuối script (phải trả về `Forbidden`).
4. Nếu bật Cloudflare, nên dùng thêm Rate Limiting rule của Cloudflare cho `/api/join`.

**Bước 5 – Sao lưu (bắt buộc)**
```bash
crontab -e
15 3 * * *  cd /opt/squeak-smash && ./scripts/backup.sh >> backups/backup.log 2>&1
```
Cài `rclone` và đặt `RCLONE_REMOTE=...` trong `.env` để mỗi bản sao lưu được chép ra **nơi khác** (Google Drive, Backblaze B2...). Bản sao lưu nằm cùng máy chủ thì mất máy là mất cả hai. **Thử khôi phục** (`./scripts/restore.sh file.sql.gz`) trên máy khác ít nhất một lần trước khi mở cửa.

**Cập nhật bản mới:** chép code mới lên, `docker compose up -d --build`. Dữ liệu nằm trong volume Docker nên không mất.

## 4. Vận hành hằng ngày

```bash
docker compose exec api node scripts/admin.js stats          # số liệu 24 giờ qua
docker compose exec api node scripts/admin.js sources 30   # nguồn nào mang về người chơi quay lại (30 ngày qua)
docker compose exec api node scripts/admin.js suspects       # ván bị đánh dấu "nghi ngờ"/"từ chối"
docker compose exec api node scripts/admin.js reject-round 123   # gỡ điểm một ván
docker compose exec api node scripts/admin.js ban TenNguoiChoi   # cấm
docker compose exec api node scripts/admin.js purge TenNguoiChoi # cấm + gỡ toàn bộ điểm
```

- **Chốt tháng:** không cần cron để "reset", vì mọi số liệu gắn với tháng nên sang tháng mới tự bắt đầu từ 0. Mỗi giờ server tự lưu bảng xếp hạng cuối của tháng đã qua vào bảng `hall_of_fame` (xem qua `GET /api/hall-of-fame`).
- **Dữ liệu cá nhân:** nhật ký cú chạm xóa sau 30 ngày, khách chưa chơi ván nào xóa sau 24 giờ, khách không hoạt động và điểm thấp xóa sau 1 năm (chỉnh trong `.env`/`server/config.js`). IP chỉ lưu dạng băm có khóa bí mật.
- **Giám sát:** dùng UptimeRobot (miễn phí) ping `https://domain/api/health`.
- **Tên xấu:** bổ sung từ vào `server/blocklist.txt` theo ngôn ngữ người chơi của bạn (danh sách mẫu rất ngắn, và việc lọc theo chuỗi con có thể chặn nhầm vài tên hiền).

## 5a. Đo nguồn người chơi (utm_source)

Gắn `?utm_source=<tên>` vào mọi link bạn đăng ra ngoài, ví dụ `https://domain/?utm_source=reddit_ph` hoặc `?c=PH&utm_source=tiktok_ph` (`c=` chọn sẵn quốc gia). Lần ghé đầu tiên được nhớ trong trình duyệt và lưu vào người chơi khi họ đăng ký. Tên nguồn chỉ gồm chữ thường, số, `_ . -`, tối đa 32 ký tự; giá trị khác bị bỏ. Nút Share trong game tự tạo link `?c=<nước người chơi>&utm_source=share`. Xem kết quả bằng lệnh `sources` ở mục 4: số người mới, số người chơi từ 3 ván, số người quay lại ngày sau. Chỉ đếm người **đã đăng ký** (nhập tên), không đếm người chỉ mở trang.

## 5. Quảng cáo (khi đã có lượng truy cập thật)

Thêm mã AdSense vào `public/index.html` chỉ ở **màn hình kết quả**, xa các nút bấm, không được khuyến khích bấm quảng cáo. Khi đó phải thêm các nguồn của Google vào Content-Security-Policy qua các biến `CSP_SCRIPT`, `CSP_FRAME`, `CSP_IMG`, `CSP_CONNECT` trong `.env` (có ví dụ sẵn), nếu không trình duyệt sẽ chặn quảng cáo. Với khách EU/UK cần hộp đồng ý cookie. AdSense yêu cầu site có đủ nội dung (trang giới thiệu, chính sách riêng tư, điều khoản) và có thể từ chối trang chỉ là một trò chơi đơn lẻ.

## 6. Việc phải làm trước khi mở cửa công khai

- **Trang Chính sách riêng tư và Điều khoản** (bắt buộc cho AdSense và theo luật). Phải nói rõ thu thập gì (tên hiển thị, quốc gia, IP băm, nhật ký chơi), để làm gì, giữ bao lâu, dữ liệu lưu ở máy chủ nước nào, cách người dùng yêu cầu xóa. Nhờ luật sư rà soát.
- **Pháp lý Việt Nam:** hỏi luật sư/cơ quan quản lý về phân loại game theo Nghị định 147/2024 (G1–G4), có cần pháp nhân, và quy định về chuyển dữ liệu cá nhân ra nước ngoài theo luật bảo vệ dữ liệu cá nhân. Tôi chưa kiểm chứng được các điểm này.
- **Giải thưởng/quà tặng hằng tháng** là một vấn đề pháp lý riêng (khuyến mại, thuế), chưa nằm trong bản này.
- Font hiện tải từ Google Fonts (lộ IP khách cho Google). Nếu muốn tránh, tải font về và đặt trong `public/`.
- Thử chơi trên điện thoại thật (iOS Safari, Android Chrome) và mạng yếu.

## 7. Giới hạn đã biết

- Ai đọc được mã nguồn trình duyệt có thể viết bot đọc lịch từ hạt giống và chạm "hoàn hảo". Bản này **không ngăn được hoàn toàn**; nó chặn các bot ngây thơ, chặn việc báo điểm giả, và đánh dấu các mẫu quá giống máy. Ngưỡng trong `analyze()` (file `shared/game-core.js`) là **ước đoán ban đầu**, cần chỉnh theo dữ liệu thật sau khi mở cửa. Nếu sau này có giải thưởng thật, hãy xem tay top 100 trước khi trao.
- Khách mất mã nếu xóa dữ liệu trình duyệt: tên cũ vẫn bị giữ, người đó phải chọn tên mới (điểm cũ vẫn nằm trong tổng quốc gia).
- Bảng xếp hạng cập nhật mỗi vài giây (có đệm 3 giây), chưa có thông báo tức thời kiểu "X vừa vượt Y" cho người chơi khác.
- Hình ảnh Docker chưa được dựng thử trong môi trường phát triển (không có Docker daemon); phần Postgres, Redis, Node, trình duyệt đã chạy thật. Hãy chạy `docker compose up -d --build` trên VPS và đọc log lần đầu.
