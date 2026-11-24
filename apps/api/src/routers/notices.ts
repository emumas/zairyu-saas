/**
 * 外国人雇用状況の届出(第1段階): 期限の管理・記入内容の一覧・提出の記録。
 * 届出が必要な出来事は登録者の入社日と在籍期間の履歴から求める(テナントの notices_from 以後だけ)。
 * 事業主が自分で提出するための補助で、提出の代行はしない。記入内容の在留カード番号は伏せて返し、全桁は cards.revealCardNumber(監査ログに残る)で出す
 */
import { deleteNoticeRecord, getEmployerInfo, listNoticeEvents, listNoticeRecords, noticePersons, siteInfo, upsertNoticeRecord, type Tx } from "@zairyu/db";
import {
  daysBetween,
  jstDate,
  NOTICE_KINDS,
  noticeDueDate,
  noticeFields,
  noticeForm,
  noticeRecordInput,
  dateString,
  type NoticeKind,
  type NoticeSource,
  type NoticeStatus,
} from "@zairyu/shared";
import { decryptCardNumber } from "@zairyu/vault";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { siteScope, type Actor } from "../authz/permissions.js";
import { permissionProcedure, requireVault, router, type Services } from "../trpc.js";
import { maskCardNumber } from "./cards.js";

const eventKey = z.object({ personId: z.uuid(), kind: z.enum(NOTICE_KINDS), eventDate: dateString });

const recordOutput = z
  .object({ submittedOn: z.string().nullable(), method: z.string().nullable(), receiptNo: z.string().nullable(), note: z.string().nullable(), updatedAt: z.date() })
  .nullable();

const itemOutput = z.object({
  personId: z.string(),
  employeeCode: z.string(),
  name: z.string(),
  siteName: z.string(),
  kind: z.enum(NOTICE_KINDS),
  eventDate: z.string(),
  insured: z.boolean().nullable(),
  form: z.string(),
  dueDate: z.string(),
  /** 期限までの日数(過ぎていれば負) */
  daysLeft: z.number(),
  status: z.enum(["pending", "submitted", "not_required"]),
  /** 自動で届出不要にした理由(特別永住者) */
  autoReason: z.string().nullable(),
  record: recordOutput,
  /** 空欄の必須の項目 */
  missing: z.array(z.string()),
});
type Item = z.infer<typeof itemOutput>;

/** 届出の一覧の材料を集める(記入内容も作れるように、元の値も返す) */
async function collect(tx: Tx, actor: Actor, today: string) {
  const employer = await getEmployerInfo(tx);
  if (!employer) return { from: today, rows: [] };
  const events = await listNoticeEvents(tx, siteScope(actor), employer.noticesFrom);
  const ids = [...new Set(events.map((e) => e.personId))];
  const people = new Map((await noticePersons(tx, ids)).map((p) => [p.id, p]));
  const records = await listNoticeRecords(tx, ids);
  const sites = new Map((await siteInfo(tx, [...new Set(events.map((e) => e.siteId))])).map((s) => [s.id, s]));
  const rows = events.flatMap((e) => {
    const p = people.get(e.personId);
    const site = sites.get(e.siteId);
    if (!p || !site) return [];
    const record = records.find((r) => r.personId === e.personId && r.kind === e.kind && r.eventDate === e.eventDate) ?? null;
    const source: NoticeSource = {
      kind: e.kind,
      eventDate: e.eventDate,
      name: p.name,
      nameKana: p.nameKana,
      birthDate: p.card?.birthDate ?? p.personBirthDate,
      sex: p.card?.sex ?? null,
      nationality: p.card?.nationality ?? p.personNationality,
      statusOfResidence: p.card?.statusOfResidence ?? null,
      expiryDate: p.card?.expiryDate ?? null,
      cardValidUntil: p.card?.cardValidUntil ?? null,
      outsideActivity: p.card?.outsideActivity ?? (p.card ? "0" : null),
      outsideActivityUntil: p.card?.outsideActivityUntil ?? null,
      cardNumberMasked: p.card?.id ? "(登録済み)" : null,
      site: { name: site.name, officialName: site.officialName, address: site.address, phone: site.phone, insuranceOfficeNumber: site.insuranceOfficeNumber },
      employer: { name: employer.name ?? employer.tenantName, address: employer.address, phone: employer.phone, representativeName: employer.representativeName },
    };
    return [{ event: e, person: p, site, record, source }];
  });
  return { from: employer.noticesFrom, rows };
}

function toItem(r: Awaited<ReturnType<typeof collect>>["rows"][number], today: string): Item {
  const { event: e, person: p, site, record, source } = r;
  const insured = p.employmentInsured;
  const dueDate = noticeDueDate(e.kind, e.eventDate, insured);
  const autoReason = p.card?.cardKind === "special_permanent" ? "特別永住者は届出の対象外です" : null;
  const status: NoticeStatus = record ? (record.status as NoticeStatus) : autoReason ? "not_required" : "pending";
  const missing = noticeFields(source, today)
    .filter((f) => !f.optional && f.value === null)
    .map((f) => f.label);
  if (insured === null) missing.unshift("雇用保険の加入");
  return {
    personId: p.id,
    employeeCode: p.employeeCode,
    name: p.name,
    siteName: site.name,
    kind: e.kind,
    eventDate: e.eventDate,
    insured,
    form: noticeForm(e.kind, insured),
    dueDate,
    daysLeft: daysBetween(today, dueDate),
    status,
    autoReason: record ? null : autoReason,
    record: record ? { submittedOn: record.submittedOn, method: record.method, receiptNo: record.receiptNo, note: record.note, updatedAt: record.updatedAt } : null,
    missing,
  };
}

/** 未提出の件数(ダッシュボード用): 期限切れ・7 日以内・それ以外 */
export async function noticeCounts(tx: Tx, actor: Actor, services: Services) {
  const today = jstDate(services.now());
  const items = (await collect(tx, actor, today)).rows.map((r) => toItem(r, today)).filter((i) => i.status === "pending");
  return { overdue: items.filter((i) => i.daysLeft < 0).length, dueSoon: items.filter((i) => i.daysLeft >= 0 && i.daysLeft <= 7).length, pending: items.length };
}

async function findEvent(tx: Tx, actor: Actor, today: string, key: { personId: string; kind: NoticeKind; eventDate: string }) {
  const r = (await collect(tx, actor, today)).rows.find((x) => x.event.personId === key.personId && x.event.kind === key.kind && x.event.eventDate === key.eventDate);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "対象の届出が見つかりません" });
  return r;
}

export const noticesRouter = router({
  list: permissionProcedure("persons.write")
    .input(z.object({ status: z.enum(["pending", "submitted", "not_required", "all"]).default("pending"), siteId: z.uuid().optional() }).default({ status: "pending" }))
    .output(z.object({ from: z.string(), items: z.array(itemOutput) }))
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const today = jstDate(ctx.services.now());
        const { from, rows } = await collect(tx, ctx.actor, today);
        const items = rows
          .filter((r) => !input.siteId || r.event.siteId === input.siteId)
          .map((r) => toItem(r, today))
          .filter((i) => input.status === "all" || i.status === input.status)
          .sort((a, b) => (a.status === "pending" && b.status === "pending" ? a.dueDate.localeCompare(b.dueDate) : b.eventDate.localeCompare(a.eventDate)));
        return { from, items };
      }),
    ),

  /** 記入内容(様式の欄の順)。在留カード番号は伏せる */
  detail: permissionProcedure("persons.write")
    .input(eventKey)
    .output(
      z.object({
        item: itemOutput,
        cardId: z.string().nullable(),
        fields: z.array(z.object({ label: z.string(), value: z.string().nullable(), secret: z.boolean().optional(), optional: z.boolean().optional() })),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const today = jstDate(ctx.services.now());
        const r = await findEvent(tx, ctx.actor, today, input);
        const enc = r.person.card?.cardNumberEnc;
        const masked = enc ? maskCardNumber(await decryptCardNumber(requireVault(ctx.services).keyring, ctx.actor.tenantId, enc)) : null;
        return { item: toItem(r, today), cardId: r.person.card?.id ?? null, fields: noticeFields({ ...r.source, cardNumberMasked: masked }, today) };
      }),
    ),

  /** 提出した/届出不要とした記録(上書き) */
  record: permissionProcedure("persons.write")
    .input(noticeRecordInput)
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await findEvent(tx, ctx.actor, jstDate(ctx.services.now()), input);
        await upsertNoticeRecord(tx, {
          personId: input.personId,
          kind: input.kind,
          eventDate: input.eventDate,
          status: input.status,
          submittedOn: input.status === "submitted" ? (input.submittedOn ?? null) : null,
          method: input.status === "submitted" ? (input.method ?? null) : null,
          receiptNo: input.status === "submitted" ? (input.receiptNo ?? null) : null,
          note: input.note ?? null,
          recordedBy: ctx.actor.userId,
        });
        await ctx.audit(tx, { action: "notice.record", targetType: "person", targetId: input.personId, detail: { kind: input.kind, eventDate: input.eventDate, status: input.status, method: input.method ?? null } });
        return { ok: true as const };
      }),
    ),

  /** 記録を取り消して未提出に戻す */
  clear: permissionProcedure("persons.write")
    .input(eventKey)
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await findEvent(tx, ctx.actor, jstDate(ctx.services.now()), input);
        if (!(await deleteNoticeRecord(tx, input.personId, input.kind, input.eventDate))) throw new TRPCError({ code: "NOT_FOUND", message: "記録がありません" });
        await ctx.audit(tx, { action: "notice.clear", targetType: "person", targetId: input.personId, detail: { kind: input.kind, eventDate: input.eventDate } });
        return { ok: true as const };
      }),
    ),
});
