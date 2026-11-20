/**
 * DB スキーマ(DESIGN.md 7章)。
 *
 * - テナントに属するテーブルはすべて tenant_id を持ち、既定値はセッション変数 app.tenant_id。
 *   アプリはテナント ID を INSERT に書かない(クライアント入力から受け取らない。CLAUDE.md ルール1)
 * - RLS ポリシー・ロール・権限・追記専用トリガーは migrations/0001_security.sql(手書き)で定義する
 * - 金額は整数(円)
 * - カード番号は暗号文(bytea)と検索用 HMAC(bytea)のみ保持し、平文は持たない(ルール2)
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** テナント ID 列。既定値をセッション変数から取り、アプリが値を渡さなくてよいようにする */
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .default(sql`(nullif(current_setting('app.tenant_id', true), ''))::uuid`)
    .references(() => tenants.id);

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------- 列挙型

export const tenantStatus = pgEnum("tenant_status", ["trial", "active", "past_due", "suspended"]);
export const userRole = pgEnum("user_role", ["tenant_admin", "site_admin", "viewer"]);
export const userStatus = pgEnum("user_status", ["invited", "active", "suspended"]);
export const personStatus = pgEnum("person_status", ["active", "retired", "archived"]);
export const cardFormat = pgEnum("card_format", ["legacy", "gen2", "tokutei"]);
export const cardKind = pgEnum("card_kind", ["residence", "special_permanent"]);
export const cardImageKind = pgEnum("card_image_kind", ["front", "back", "ic_face", "ic_front", "ic_name", "ic_address"]);
export const verificationMethod = pgEnum("verification_method", ["ic_signature", "ocr", "visual", "revocation_check"]);
/** unverifiable: 年少者カード等で署名がなく IC 署名検証ができない(DESIGN.md 7章に追加) */
export const verificationResult = pgEnum("verification_result", ["ok", "mismatch", "failed", "revoked", "unverifiable"]);
export const alertType = pgEnum("alert_type", [
  "expiry_90",
  "expiry_60",
  "expiry_30",
  "expired",
  "recheck_revocation",
  "hours_limit",
  /** 署名検証に失敗(偽造の疑い)。登録時に即時通知 */
  "needs_review",
]);
export const notificationChannel = pgEnum("notification_channel", ["push", "email"]);
export const notificationStatus = pgEnum("notification_status", ["pending", "sent", "failed"]);
export const billingMode = pgEnum("billing_mode", ["per_unit", "tiered"]);
export const billingPeriodStatus = pgEnum("billing_period_status", ["open", "finalized", "reported", "paid", "failed"]);

// ---------------------------------------------------------------- 契約・プラン(運営者が管理)

export const plans = pgTable("plans", {
  id: id(),
  name: text("name").notNull(),
  /** 月額基本料(円) */
  baseFee: integer("base_fee").notNull().default(0),
  billingMode: billingMode("billing_mode").notNull(),
  /** per_unit の単価(円) */
  unitPrice: integer("unit_price"),
  /** tiered の人数帯: [{ upTo: number | null, unitPrice: number }] */
  tiersJson: jsonb("tiers_json"),
  createdAt: createdAt(),
}, (t) => [
  check("plans_amounts_ck", sql`${t.baseFee} >= 0 and coalesce(${t.unitPrice}, 0) >= 0`),
  check(
    "plans_mode_ck",
    sql`(${t.billingMode} = 'per_unit' and ${t.unitPrice} is not null) or (${t.billingMode} = 'tiered' and ${t.tiersJson} is not null)`,
  ),
]);

export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  status: tenantStatus("status").notNull().default("trial"),
  stripeCustomerId: text("stripe_customer_id"),
  planId: uuid("plan_id").references(() => plans.id),
  /** 退職後の保存期間(年)。3〜5、標準 5 */
  retentionYears: integer("retention_years").notNull().default(5),
  /** 支払い失敗の日時(未払い時の制御。1-18) */
  pastDueSince: timestamp("past_due_since", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [check("tenants_retention_years_ck", sql`${t.retentionYears} between 3 and 5`)]);

export const tenantPriceOverrides = pgTable("tenant_price_overrides", {
  id: id(),
  tenantId: tenantId().unique(),
  planId: uuid("plan_id").references(() => plans.id),
  baseFee: integer("base_fee"),
  unitPrice: integer("unit_price"),
  tiersJson: jsonb("tiers_json"),
  createdAt: createdAt(),
});

/** 運営者(テナントに属さない)。登録者の個人情報は見ない */
export const platformOperators = pgTable("platform_operators", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEnc: bytea("totp_secret_enc"),
  /** 最後に受け付けた TOTP のタイムステップ(同じコードの再利用を防ぐ) */
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** 運営者の操作の記録(追記専用。テナントに属さない操作: プランの変更など) */
export const platformAuditLogs = pgTable(
  "platform_audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    operatorId: uuid("operator_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** 変更した項目名など */
    detail: jsonb("detail"),
    ip: inet("ip"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("platform_audit_logs_at_idx").on(t.at)],
);

export const tenantKeyPurpose = pgEnum("tenant_key_purpose", ["data", "hmac"]);

/**
 * テナント別の鍵(エンベロープ暗号化)。鍵そのものは Key Vault の KEK で包んだ状態でだけ保存する。
 * data: カード番号・画像の暗号化(ローテーション可。古い版も復号用に残す)
 * hmac: カード番号の検索列(変えると検索列の作り直しが必要なため原則固定)
 */
export const tenantKeys = pgTable(
  "tenant_keys",
  {
    tenantId: tenantId(),
    purpose: tenantKeyPurpose("purpose").notNull(),
    version: integer("version").notNull(),
    /** 包んだ鍵(KEK の識別子とあわせて unwrap する) */
    wrappedKey: bytea("wrapped_key").notNull(),
    /** KEK の識別子(Key Vault の鍵 ID、ローカルなら local:<版>) */
    kekId: text("kek_id").notNull(),
    /** 新しい暗号化に使う版か(purpose ごとに 1 つ) */
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.purpose, t.version] }),
    uniqueIndex("tenant_keys_active_uq")
      .on(t.tenantId, t.purpose)
      .where(sql`${t.active}`),
  ],
);

// ---------------------------------------------------------------- 組織

export const sites = pgTable(
  "sites",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("sites_tenant_idx").on(t.tenantId)],
);

export const users = pgTable(
  "users",
  {
    id: id(),
    tenantId: tenantId(),
    /** ログイン ID。全テナントで一意(小文字で保存) */
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    role: userRole("role").notNull(),
    status: userStatus("status").notNull().default("invited"),
    totpSecretEnc: bytea("totp_secret_enc"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    /** 最後に受け付けた TOTP のタイムステップ(同じコードの再利用を防ぐ) */
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    /** 連続したログイン失敗の回数とロック解除時刻 */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`), index("users_tenant_idx").on(t.tenantId)],
);

export const userSites = pgTable(
  "user_sites",
  {
    tenantId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.siteId] })],
);

/**
 * ユーザーの招待(1-15)。トークンは "<テナントID>.<乱数>" で、DB には SHA-256 だけを保存する
 */
export const userInvitations = pgTable(
  "user_invitations",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("user_invitations_hash_uq").on(t.tokenHash)],
);

/**
 * リフレッシュトークン(ハッシュのみ保存)。ローテーションし、同じ family で使用済みのものが
 * 再利用されたら盗用とみなして family ごと失効させる
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256(トークン) */
    tokenHash: bytea("token_hash").notNull(),
    familyId: uuid("family_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    deviceName: text("device_name"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("refresh_tokens_hash_uq").on(t.tokenHash), index("refresh_tokens_family_idx").on(t.familyId)],
);

// ---------------------------------------------------------------- 登録者とカード

export const persons = pgTable(
  "persons",
  {
    id: id(),
    tenantId: tenantId(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    employeeCode: text("employee_code").notNull(),
    name: text("name").notNull(),
    nationality: text("nationality"),
    birthDate: date("birth_date"),
    /** 課金対象の判定に使う(active のみ数える) */
    status: personStatus("status").notNull().default("active"),
    retiredAt: date("retired_at"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("persons_employee_code_uq").on(t.tenantId, t.employeeCode),
    index("persons_tenant_site_status_idx").on(t.tenantId, t.siteId, t.status),
  ],
);

export const residenceCards = pgTable(
  "residence_cards",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id),
    cardFormat: cardFormat("card_format").notNull(),
    cardKind: cardKind("card_kind").notNull().default("residence"),
    /** カード番号の暗号文(テナント別鍵) */
    cardNumberEnc: bytea("card_number_enc").notNull(),
    /** カード番号の検索用 HMAC */
    cardNumberHmac: bytea("card_number_hmac").notNull(),
    /** カード記載の生年月日・性別(M / F)・国籍・地域(第2世代は IC の値、旧様式は券面の読み取り・入力) */
    birthDate: date("birth_date"),
    sex: text("sex"),
    nationality: text("nationality"),
    /** 住居地(テナントの鍵で暗号化。検索しない) */
    addressEnc: bytea("address_enc"),
    /** 住居地の出どころ: ic_back(IC の裏面追記)/ back_photo / front_photo / manual */
    addressSource: text("address_source"),
    /** 裏面に住居地が記載された日(IC の裏面追記の日付) */
    addressWrittenAt: date("address_written_at"),
    statusOfResidence: text("status_of_residence"),
    periodOfStay: text("period_of_stay"),
    permissionType: text("permission_type"),
    permittedAt: date("permitted_at"),
    /** 在留期間の満了日(期限区分・アラートの基準) */
    expiryDate: date("expiry_date"),
    /** カード自体の有効期限 */
    cardValidUntil: date("card_valid_until"),
    /** 就労制限 1:なし 2:在留資格に基づく就労のみ 4:指定書による就労のみ 9:就労不可 */
    workRestriction: text("work_restriction"),
    /** 資格外活動許可(第2世代: 0/1/2、旧様式: 記載内容テキスト) */
    outsideActivity: text("outside_activity"),
    outsideActivityUntil: date("outside_activity_until"),
    /** 在留期間更新等許可申請中(特例期間の追跡) */
    pendingApplication: boolean("pending_application").notNull().default(false),
    pendingApplicationSince: date("pending_application_since"),
    /** IC の署名検証に成功したか */
    icVerified: boolean("ic_verified").notNull().default(false),
    /** 偽造の疑い等で要確認 */
    needsReview: boolean("needs_review").notNull().default(false),
    /** カード交付日(交付当日の失効照会は翌日再照会) */
    issuedAt: date("issued_at"),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("residence_cards_current_uq")
      .on(t.personId)
      .where(sql`${t.isCurrent}`),
    index("residence_cards_hmac_idx").on(t.tenantId, t.cardNumberHmac),
    index("residence_cards_expiry_idx")
      .on(t.tenantId, t.expiryDate)
      .where(sql`${t.isCurrent}`),
  ],
);

export const cardImages = pgTable(
  "card_images",
  {
    id: id(),
    tenantId: tenantId(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => residenceCards.id),
    kind: cardImageKind("kind").notNull(),
    /** Blob 上のキー(実体はテナント別鍵で暗号化) */
    blobKey: text("blob_key").notNull(),
    contentType: text("content_type").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("card_images_card_idx").on(t.cardId)],
);

/** 確認履歴(追記専用) */
export const verifications = pgTable(
  "verifications",
  {
    id: id(),
    tenantId: tenantId(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => residenceCards.id),
    method: verificationMethod("method").notNull(),
    result: verificationResult("result").notNull(),
    diffJson: jsonb("diff_json"),
    note: text("note"),
    performedBy: uuid("performed_by")
      .notNull()
      .references(() => users.id),
    deviceId: text("device_id"),
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verifications_card_idx").on(t.cardId, t.performedAt)],
);

export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id),
    cardId: uuid("card_id").references(() => residenceCards.id),
    type: alertType("type").notNull(),
    dueDate: date("due_date").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sendAttempts: integer("send_attempts").notNull().default(0),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // 日次ジョブを何度実行しても同じアラートを重複して作らない
    uniqueIndex("alerts_dedupe_uq").on(t.personId, t.type, t.dueDate),
    index("alerts_open_idx")
      .on(t.tenantId, t.dueDate)
      .where(sql`${t.acknowledgedAt} is null`),
  ],
);

/** 端末のプッシュ通知トークン(Expo Push) */
export const userDevices = pgTable(
  "user_devices",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    expoPushToken: text("expo_push_token").notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_devices_token_uq").on(t.expoPushToken)],
);

/**
 * 通知の送信待ち(アウトボックス)。アラートを作った処理と同じトランザクションで積み、送信ジョブが再送つきで送る。
 * payload には件数などだけを入れ、氏名・カード番号は入れない(ロック画面やメールに出るため)
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: notificationChannel("channel").notNull(),
    /** { title, body, kind } */
    payload: jsonb("payload").notNull(),
    status: notificationStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** 失敗の理由(送信先の応答コード等。個人情報は入れない) */
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [index("notification_outbox_due_idx").on(t.status, t.nextAttemptAt)],
);

/** フェーズ2(週就労時間) */
export const workHours = pgTable(
  "work_hours",
  {
    tenantId: tenantId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id),
    weekStart: date("week_start").notNull(),
    /** 分単位(浮動小数点を避ける) */
    minutes: integer("minutes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.weekStart] }), check("work_hours_minutes_ck", sql`${t.minutes} >= 0`)],
);

// ---------------------------------------------------------------- 課金

export const dailyCounts = pgTable(
  "daily_counts",
  {
    tenantId: tenantId(),
    date: date("date").notNull(),
    activeCount: integer("active_count").notNull(),
    recordedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.date] })],
);

export const billingPeriods = pgTable(
  "billing_periods",
  {
    id: id(),
    tenantId: tenantId(),
    /** YYYY-MM */
    period: text("period").notNull(),
    peakCount: integer("peak_count").notNull(),
    /** 請求額(円・税抜) */
    amount: integer("amount").notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    status: billingPeriodStatus("status").notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("billing_periods_uq").on(t.tenantId, t.period),
    check("billing_periods_period_ck", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("billing_periods_amounts_ck", sql`${t.peakCount} >= 0 and ${t.amount} >= 0`),
  ],
);

// ---------------------------------------------------------------- 監査

/** 監査ログ(追記専用)。カード画像の閲覧も記録する */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: tenantId(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** 補足(変更した項目名など)。値(個人情報)は入れない */
    detail: jsonb("detail"),
    ip: inet("ip"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_tenant_at_idx").on(t.tenantId, t.at)],
);
