/**
 * 旧様式の在留カード表面を、IC の券面イメージ(文字部分。白は透明)と顔写真から組み立てて表示する。
 * 配置はアプリと共有(@zairyu/shared の cardLayout)。文字の大きさはカード幅に対する割合(cqw)で決める
 */
import {
  gen2FaceTexts,
  GEN2_ADDRESS_BOX,
  GEN2_BACKGROUND,
  GEN2_BANDS,
  GEN2_FACE_BOX,
  GEN2_NAME_BOX,
  isStatusCode,
  LABEL_EN_SIZE,
  LABEL_SIZE,
  LEGACY_BANDS,
  LEGACY_FACE_BOX,
  LEGACY_FRONT_LABELS,
  nationalityName,
  WORK_RESTRICTION_LABEL,
  type CardFaceFields,
} from "@zairyu/shared";

export interface ImageData {
  contentType: string;
  data: string;
  width: number;
  height: number;
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const cqw = (v: number) => `${(v * 100).toFixed(3)}cqw`;
const src = (img: ImageData) => `data:${img.contentType};base64,${img.data}`;

export function CardFaceView({ front, face }: { front: ImageData; face?: ImageData | null | undefined }) {
  const ratio = front.width > 0 && front.height > 0 ? `${front.width} / ${front.height}` : "85.6 / 54";
  return (
    <div className="cardface-wrap">
      <div className="cardface" style={{ aspectRatio: ratio }}>
        {LEGACY_BANDS.map((b, i) => (
          <div key={i} className="cardface-band" style={{ left: pct(b.x), top: pct(b.y), width: pct(b.width), height: pct(b.height) }} />
        ))}
        {LEGACY_FRONT_LABELS.map((l) => (
          <div key={l.ja} className="cardface-label" style={{ left: pct(l.x), top: pct(l.y) }}>
            <div style={{ fontSize: cqw(l.size ?? LABEL_SIZE) }}>{l.ja}</div>
            {l.en && <div style={{ fontSize: cqw(LABEL_EN_SIZE), lineHeight: 1.15 }}>{l.en}</div>}
          </div>
        ))}
        {face && (
          <img
            alt="顔写真"
            src={src(face)}
            style={{ left: pct(LEGACY_FACE_BOX.x), top: pct(LEGACY_FACE_BOX.y), width: pct(LEGACY_FACE_BOX.width), height: pct(LEGACY_FACE_BOX.height), objectFit: "cover" }}
          />
        )}
        <img alt="券面イメージ" src={src(front)} style={{ left: 0, top: 0, width: "100%", height: "100%" }} />
      </div>
      <p className="hint">IC の記録から組み立てた表示です(地紋などのデザインは省略しています)。</p>
    </div>
  );
}

const boxStyle = (b: { x: number; y: number; width: number; height: number }) => ({ left: pct(b.x), top: pct(b.y), width: pct(b.width), height: pct(b.height) });

/**
 * 第2世代・特定在留カードの表面を、IC の文字情報(券面記載事項)と氏名・住居地・顔の画像から組み立てて表示する。
 * IC に券面イメージが無いため、配置は旧様式に合わせた目安
 */
export function Gen2CardFaceView({
  kind,
  fields,
  cardNumber,
  name,
  face,
  address,
}: {
  kind: "residence" | "special_permanent";
  fields: CardFaceFields;
  cardNumber?: string | null | undefined;
  name?: ImageData | null | undefined;
  face?: ImageData | null | undefined;
  address?: ImageData | null | undefined;
}) {
  const { labels, values } = gen2FaceTexts(fields, {
    kind,
    cardNumber: cardNumber ?? null,
    statusIsCode: isStatusCode(fields.statusOfResidence),
    workRestrictionLabel: (c) => WORK_RESTRICTION_LABEL[c as keyof typeof WORK_RESTRICTION_LABEL] ?? null,
    nationalityLabel: nationalityName,
  });
  return (
    <div className="cardface-wrap">
      <div className="cardface" style={{ aspectRatio: "85.6 / 54", background: GEN2_BACKGROUND }}>
        {GEN2_BANDS.map((b, i) => (
          <div key={i} className="cardface-band" style={boxStyle(b)} />
        ))}
        {labels.map((l) => (
          <div key={l.ja} className="cardface-label" style={{ left: pct(l.x), top: pct(l.y) }}>
            <div style={{ fontSize: cqw(l.size ?? LABEL_SIZE) }}>{l.ja}</div>
            {l.en && <div style={{ fontSize: cqw(LABEL_EN_SIZE), lineHeight: 1.15 }}>{l.en}</div>}
          </div>
        ))}
        {values.map((t) => (
          <div key={`${t.x}-${t.y}`} className="cardface-value" style={{ left: pct(t.x), top: pct(t.y), fontSize: cqw(t.size) }}>
            {t.text}
          </div>
        ))}
        {name && <img alt="氏名イメージ" src={src(name)} style={{ ...boxStyle(GEN2_NAME_BOX), objectFit: "contain", objectPosition: "left center" }} />}
        {address && <img alt="住居地イメージ" src={src(address)} style={{ ...boxStyle(GEN2_ADDRESS_BOX), objectFit: "contain", objectPosition: "left center" }} />}
        {face && <img alt="顔写真" src={src(face)} style={{ ...boxStyle(GEN2_FACE_BOX), objectFit: "cover" }} />}
      </div>
      <p className="hint">IC の記録(文字情報と氏名・住居地・顔の画像)から組み立てた表示です。配置は目安で、地紋などのデザインは省略しています。</p>
    </div>
  );
}
