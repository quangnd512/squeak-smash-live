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

**Thỏ Clover xuất hiện nhiều dần:** tỉ lệ thỏ trong `shared/game-core.js` tăng đều theo thời gian của ván, từ 4% lúc bắt đầu lên 24% ở giây cuối (`P_BUNNY_START`, `P_BUNNY_END`; trung bình khoảng 14%, trước đây cố định 12%). File này dùng chung cho trình duyệt và server nên sửa xong phải cập nhật cả hai cùng lúc (`docker compose up -d --build`); ván nào đang chơi dở đúng lúc cập nhật có thể bị tính sai hoặc bị đánh dấu nghi ngờ, nên làm lúc ít người chơi.

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
docker compose exec api node scripts/admin.js visits 14        # lượt truy cập theo ngày (14 ngày qua)
docker compose exec api node scripts/admin.js visits 30 src    # truy cập theo utm_source (cũng có: ref, country)
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

Gắn `?utm_source=<tên>` vào mọi link bạn đăng ra ngoài, ví dụ `https://domain/?utm_source=reddit_ph` hoặc `?c=PH&utm_source=tiktok_ph` (`c=` chọn sẵn quốc gia). Lần ghé đầu tiên được nhớ trong trình duyệt và lưu vào người chơi khi họ đăng ký. Tên nguồn chỉ gồm chữ thường, số, `_ . -`, tối đa 32 ký tự; giá trị khác bị bỏ. Nút Share trong game tự tạo link `?c=<nước người chơi>&utm_source=share`. Xem kết quả bằng lệnh `sources` ở mục 4: số người mới, số người chơi từ 3 ván, số người quay lại ngày sau. Lệnh `sources` chỉ đếm người **đã đăng ký** (nhập tên); người chỉ mở trang xem ở mục 5b.

## 5b. Đếm lượt truy cập (chạy ngầm, người chơi không thấy)

Mỗi lần ai đó tải trang game (`/`), server tự ghi một dòng vào bảng `visits`. Trang web không có thêm mã nào, không đặt cookie, không hiện thông báo; chỉ quản trị viên xem được, bằng lệnh `visits` ở mục 4.

```bash
docker compose exec api node scripts/admin.js visits            # theo ngày, 14 ngày qua
docker compose exec api node scripts/admin.js visits 30         # 30 ngày
docker compose exec api node scripts/admin.js visits 30 src     # theo utm_source của link vào
docker compose exec api node scripts/admin.js visits 30 ref     # theo trang giới thiệu (ví dụ www.reddit.com)
docker compose exec api node scripts/admin.js visits 30 country # theo quốc gia (cần Cloudflare)
```

- **Các cột (theo ngày):** `visitors` = người truy cập khác nhau trong ngày (không tính bot); `page_views` = số lần tải trang; `bots` = số "người" bị nhận là bot (Googlebot, UptimeRobot, curl...); `new_players` = người chơi mới đăng ký trong ngày. So `new_players` với `visitors` để biết bao nhiêu phần trăm người vào thì chịu chơi.
- **"Người truy cập" tính thế nào:** mã băm có khóa bí mật của IP + trình duyệt + ngày (dùng `HASH_SECRET`). Mã đổi mỗi ngày nên không theo dõi được một người qua nhiều ngày; ai vào hai ngày thì được đếm hai lần. IP gốc không được lưu. Dòng tổng cuối bảng cũng đếm theo cách đó.
- **Chỉ số chỉ là ước lượng:** trình duyệt giữ trang tối đa 5 phút nên tải lại trong khoảng đó không được tính; nhiều người chung IP và cùng loại trình duyệt (ví dụ cùng mạng công ty) có thể bị gộp làm một; bot lạ không khai tên có thể lọt vào số người thật.
- **Cột nguồn:** `src` lấy từ `?utm_source=` của link vào (cùng quy tắc ở mục 5a); `ref` chỉ lưu tên miền của trang giới thiệu, không lưu đường dẫn đầy đủ; `country` đọc từ header của Cloudflare, nếu chưa dùng Cloudflare thì hiện `(unknown)`.
- **Lưu bao lâu:** 400 ngày rồi tự xóa (đổi bằng `VISIT_RETENTION_DAYS` trong `.env`). Bảng nằm trong Postgres nên đã có trong bản sao lưu.
- **Lưu ý pháp lý:** Chính sách riêng tư vẫn phải nói game đo lượt truy cập ẩn danh (IP băm, trình duyệt, trang giới thiệu); không cần hiện thông báo trong game nhưng phải có câu đó trong chính sách.
- **Cập nhật lên VPS:** push code, `git pull`, `docker compose up -d --build`. Bảng `visits` tự tạo khi api khởi động.

## 5c. Chia sẻ điểm và nhân vật phản ứng cuối ván

- **Nút Share** ở màn hình kết quả mở bảng "Share your score": ảnh điểm 1080x1350 (vẽ ngay trong trình duyệt, không tải gì từ ngoài), nút Save image, Share… (điện thoại: gửi cả ảnh qua Facebook, Messenger, Zalo, Instagram… nếu máy hỗ trợ), Facebook, X, WhatsApp, Telegram, Reddit, Copy link. Facebook và Instagram không nhận ảnh từ trang web nên người chơi lưu ảnh rồi tự đăng; link gửi đi hiện ảnh xem trước `public/og.png` (cần có thật trên domain, thẻ `og:` nằm ở đầu `index.html`).
- **Mỗi nền tảng một nguồn riêng:** link chia sẻ mang `utm_source=share_facebook`, `share_x`, `share_whatsapp`, `share_telegram`, `share_reddit`, hoặc `share` (gửi thẳng/sao chép). Xem bằng `admin.js sources 30` và `admin.js visits 30 src`.
- **Goldie và Pip:** sau mỗi ván đã được server xác nhận, một cửa sổ toàn màn hình hiện ra vài giây (mặc định 4 giây, chạm vào màn hình hoặc nhấn Esc để đóng sớm). Nếu điểm cao hơn kỷ lục của người chơi thì Goldie vàng nhảy múa trong mưa giấy màu và chúc mừng; nếu không thì Pip nháy mắt, lè lưỡi và trêu. Hai nhân vật vẽ toàn thân theo Hồ sơ nhân vật (hàm `charSvg` trong `public/index.html`). Ván không được xác nhận thì không hiện. Ván bằng đúng kỷ lục cũ tính là không phá kỷ lục, nên Pip trêu.
- **Sửa câu thoại:** mở file `public/mascot-lines.js` (có hướng dẫn ngay đầu file). Mảng `goldie` là các câu khích lệ, mảng `pip` là các câu chế giễu, `popupSeconds` là số giây hiện popup. Các câu được đưa ra lần lượt nên người chơi thấy hết rồi mới lặp. Dùng `{score}`, `{gain}`, `{gap}` nếu muốn chèn số. Sửa xong chạy `docker compose up -d --build` để áp dụng; trình duyệt có thể giữ bản cũ tối đa 5 phút.
- **Ảnh xem trước og.png** vẽ bằng cùng hàm `drawMouse` trong `index.html`. Muốn đổi, vẽ lại bằng trình duyệt headless rồi chép đè `public/og.png`.

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
