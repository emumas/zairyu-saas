# 開発環境の準備(Windows + Android 実機)

ログイン・カード登録を試すには、PC に PostgreSQL が必要です(フェーズ0 の PoC 画面だけなら不要)。

## 1. PostgreSQL を入れる(初回だけ)

1. https://www.postgresql.org/download/windows/ から PostgreSQL 16 以降のインストーラーを入れる
   - 途中で決める `postgres` ユーザーのパスワードを控える。ポートは 5432 のまま
   - Stack Builder は不要(チェックを外してよい)
2. スタートメニューの「SQL Shell (psql)」を開き、Enter を 4 回(既定値)→ パスワードを入力して、次を実行する

   ```sql
   CREATE DATABASE zairyu;
   ```

## 2. API の設定ファイルを作る(初回だけ)

`zairyu-saas` フォルダで実行します。`<パスワード>` は 1 で決めたもの、`<IP>` は `ipconfig` で調べた PC の IPv4 アドレスです。

```powershell
pnpm --filter api dev:init-env -- --database-url "postgres://postgres:<パスワード>@localhost:5432/zairyu" --public-url "http://<IP>:3000"
```

`apps\api\.env` ができます。中の鍵はこの PC 専用です(コミットしない)。

## 3. DB を作り、管理者ユーザーを作る(初回と、DB の変更があったとき)

```powershell
pnpm --filter api dev:setup -- --email "自分のメールアドレス" --password "12文字以上のパスワード"
```

テナント「開発用テナント」・拠点「本社」・テナント管理者ができます。2 回目以降はマイグレーションだけが適用されます。

## 4. 起動する(毎回)

**ウィンドウ①(API)**

```powershell
cd apps\api
pnpm dev
```

`.env` を読むので、`$env:...` の指定は不要です。

**ウィンドウ②(Metro)**

```powershell
cd apps\mobile
pnpm start -- --clear
```

ネイティブのモジュールが増えたときは、代わりに `pnpm android` でアプリを作り直します(2026-11-20 のログイン・カード登録の追加で必要)。

**ウィンドウ③(Web 管理画面。使うときだけ)**

```powershell
cd apps\web
pnpm dev
```

ブラウザで http://localhost:5173 を開き、アプリと同じメールアドレス・パスワードでログインします(テナント管理者・拠点管理者は認証アプリの 6 桁も入力)。API には Vite が中継するので、API(ウィンドウ①)も起動しておきます。招待リンクの宛先は `apps\api\.env` の `WEB_BASE_URL`(省略時は http://localhost:5173)です。

## 5. アプリでログインする

1. メールアドレスとパスワードでログイン
2. 管理者は初回に「認証アプリの設定」が出る。Google Authenticator などを入れておき、「認証アプリに追加」(同じ端末)または表示されたキーを手で入力 → 表示された 6 桁を入力
3. 以後は、アプリを開くたび(30 秒以上離れたあと)に指紋・顔認証でロックを解除する

## 6. カードを登録する

1. ホームの「登録者を追加」で登録者を作る(社員番号・氏名・拠点)
2. 登録者を選ぶ → 「カードを登録」
3. 表面撮影 → 番号確認 → IC 読み取り → 照合結果(旧様式は満了日などを入力)→ 裏面撮影 → 保存

## 7. アラートを試す(任意)

期限アラートの作成と通知の送信は、本番では定期実行します。開発中は手で実行できます(`apps\api\.env` を読みます)。

```powershell
pnpm --filter worker daily   # 前日の課金対象人数の記録、今日の期限アラートの作成、通知の送信
pnpm --filter worker send    # 送信待ちの通知だけを送る
pnpm --filter worker purge -- --dry-run   # 保存期間が過ぎた退職者の件数(消さない)
pnpm --filter worker purge   # 保存期間が過ぎた退職者のデータと、記録の無い古い画像ファイルを消す(元に戻せない)
```

メールの設定(`ACS_CONNECTION_STRING`・`ACS_SENDER_ADDRESS`)が無い間は、送らずにウィンドウに件数を表示するだけです。
アプリのホームの「アラート(未対応)を見る」で一覧と対応済みの操作ができます。

## 8. 契約・請求を試す(任意)

Web 管理画面の「契約・請求」(テナント管理者)で、今の課金対象人数・当月の見込み額・日別人数を見られます。

- `pnpm --filter api dev:setup -- --email ... --password ...` を実行すると、プランが無ければ開発用の段階制プラン(基本料 10,000 円、〜100 人 300 円、〜500 人 250 円…)が付きます。プランの変更は運営者コンソール(9 章)で行います
- 日別人数は `pnpm --filter worker daily` で前日分が記録されます(本番では毎日 0:30 ごろに定期実行)

## 9. 運営者コンソール(任意)

テナントの開設・契約状態・プラン・個別単価を管理する画面です。テナントのユーザーとは別のアカウントで、画面からは作れません。

```powershell
cd apps\api
pnpm platform:create-operator -- --email ops@example.com --password "12文字以上のパスワード"
```

表示された「キー」を認証アプリに手入力で登録します(キーはこのときだけ表示されます。テナントのメールアドレスとは別のものにしてください)。登録しそびれたときや端末を替えたときは、同じコマンドに `--reset-totp` を付けて実行するとキーを作り直します(パスワードもそのとき指定したものになります)。
運営者の一覧・停止・再開も CLI で行います(最後の 1 人は停止できません。再開するとログイン失敗によるロックも解除します)。

```powershell
pnpm platform:operator -- --list
pnpm platform:operator -- --disable --email ops@example.com
pnpm platform:operator -- --enable --email ops@example.com
```

ブラウザで http://localhost:5173/platform を開き、メールアドレス・パスワード・認証アプリの 6 桁でログインします。運営者には登録者の氏名などは表示されません。

## 10. 郵便番号データを入れる(初回と、月 1 回ほど)

住居地から郵便番号を自動で入れるため、日本郵便の郵便番号データ(個人情報を含まない公開データ)を DB に入れます。住所は外部に送らず、この DB の中で照合します。

```powershell
cd apps\api
pnpm postal:load
```

日本郵便のサイトから取得して全件を入れ替えます(数十秒)。自動で取得できない場合(サイトの構成変更など)は、ブラウザで日本郵便の「郵便番号データダウンロード」ページから「全国一括」の zip(UTF-8 版・Shift_JIS 版のどちらでも可)を保存し、`pnpm postal:load -- --file <保存した zip のパス>` で入れます。データは毎月更新されるので、本番では月 1 回の定期実行にします。

## 11. 外出先からテストする(Tailscale・無料)

PC をインターネットに公開せずに、外出先(スマホのモバイル回線など)から PC の API・Web・Metro に接続します。Tailscale に招待した端末だけがつながり、通信は暗号化されます。テストデータには実カードの個人情報が入るので、ルーターのポート開放はしないでください。

### 11-1. Tailscale を入れる(初回だけ)
1. PC に Tailscale(Windows 版)を入れてログインする(Google・Microsoft のアカウントなどで可)
2. スマホに Tailscale(Google Play)を入れ、**同じアカウント**でログインして「接続」をオンにする
3. PC のタスクバーの Tailscale のアイコン →「This device」に出る `100.x.x.x` が PC の Tailscale の IP。以下 `<TS_IP>` と書きます(PowerShell で `tailscale ip -4` でも確認できます)
4. PC の Tailscale の設定で「Run unattended」(ログアウト中もつなぐ)をオンにし、Windows の電源設定で**スリープしない**ようにする

### 11-2. Windows のファイアウォールで、Tailscale からの通信だけを許可する(初回だけ)
PowerShell を**管理者として実行**し、次を 1 回だけ実行します(Tailscale の範囲 `100.64.0.0/10` からだけ、API・Web・Metro のポートを開けます)。

```powershell
New-NetFirewallRule -DisplayName "zairyu dev (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 3000,5173,8081 -RemoteAddress 100.64.0.0/10 -Action Allow
```

### 11-3. 接続先を Tailscale の IP にする(初回と、IP が変わったとき)
- `apps/api/.env` の `PUBLIC_BASE_URL=http://<TS_IP>:3000`
- `apps/mobile/.env` の `EXPO_PUBLIC_API_URL=http://<TS_IP>:3000`

家で使うときも、スマホの Tailscale をオンにしておけば同じ設定のまま使えます(LAN の IP に戻す必要はありません)。

### 11-4. 起動する(毎回)
API と Web は「4. 起動する」と同じです(Web は PC のすべての接続口で待ち受けます)。アプリの Metro だけ、接続先の IP を指定して起動します。

```powershell
cd C:\Users\royal\zairyu-saas\apps\mobile
$env:REACT_NATIVE_PACKAGER_HOSTNAME = "<TS_IP>"
pnpm start -- --clear
```

開発用アプリの起動画面に Metro のサーバーが出ないときは、「Enter URL manually」に `http://<TS_IP>:8081` を入れます。

### 11-5. 確かめる
1. スマホの Wi-Fi を切ってモバイル回線にする(Tailscale はオンのまま)
2. スマホのブラウザで `http://<TS_IP>:3000/trpc/health` が開ける
3. スマホのブラウザで `http://<TS_IP>:5173` の Web 管理画面にログインできる
4. アプリを完全に終了して開き直し、ロック解除・登録者の一覧が表示できる

### 11-6. ほかの人にテストしてもらうとき
その人を Tailscale のアカウントに招待し、その人の端末にも Tailscale を入れてもらいます(無料プランは少人数まで)。公開 URL で見せたいときは Cloudflare Tunnel + Cloudflare Access(要相談)を使います。

## トラブル: `pnpm build` で `spawn UNKNOWN`

ビルドを取りまとめるツール(Turbo)が Windows のセキュリティ機能などで起動できない場合でも、`pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm dev` は自動で pnpm の順次実行に切り替わります(「Turbo を起動できないため、pnpm で順に実行します」と表示)。速さは落ちますが結果は同じです。Turbo を直すには `pnpm install --force` を試し、それでもだめなら Windows セキュリティの保護の履歴を確認してください。
