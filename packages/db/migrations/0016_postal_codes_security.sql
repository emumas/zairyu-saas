-- 郵便番号データ(参照データ。テナントに属さない)。アプリ・運営者は参照のみ、投入は管理ユーザー(テーブル所有者)のスクリプト
GRANT SELECT ON postal_codes TO zairyu_app, zairyu_platform;
