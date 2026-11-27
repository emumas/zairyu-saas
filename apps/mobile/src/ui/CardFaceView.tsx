/**
 * 旧様式の在留カード表面を、IC の券面イメージ(文字部分。白は透明)と顔写真から組み立てて表示する。
 * 背景のデザイン(地紋・ホログラム)は再現しない。項目名はこのアプリで描く
 */
import { useState } from "react";
import { Image, Text, View } from "react-native";
import {
  gen2FaceTexts,
  GEN2_ADDRESS_BOX,
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
  type CardLabel,
} from "@zairyu/shared";
import { color } from "./kit";

export interface ImageData {
  contentType: string;
  data: string;
  width: number;
  height: number;
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%` as const;

export function CardFaceView({ front, face }: { front: ImageData; face?: ImageData | null | undefined }) {
  const [width, setWidth] = useState(0);
  const ratio = front.width > 0 && front.height > 0 ? front.width / front.height : 85.6 / 54;
  return (
    <View style={{ gap: 4 }}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ width: "100%", aspectRatio: ratio, backgroundColor: "#edf5e9", borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: color.border }}
      >
        {LEGACY_BANDS.map((b, i) => (
          <View
            key={i}
            style={{ position: "absolute", left: pct(b.x), top: pct(b.y), width: pct(b.width), height: pct(b.height), backgroundColor: "#d7e8f3" }}
          />
        ))}
        {width > 0 &&
          LEGACY_FRONT_LABELS.map((l) => (
            <View key={l.ja} style={{ position: "absolute", left: pct(l.x), top: pct(l.y) }}>
              <Text style={{ fontSize: width * (l.size ?? LABEL_SIZE), color: "#4a5a4a" }}>{l.ja}</Text>
              {l.en && <Text style={{ fontSize: width * LABEL_EN_SIZE, lineHeight: width * LABEL_EN_SIZE * 1.15, color: "#4a5a4a" }}>{l.en}</Text>}
            </View>
          ))}
        {face && (
          <Image
            source={{ uri: `data:${face.contentType};base64,${face.data}` }}
            style={{ position: "absolute", left: pct(LEGACY_FACE_BOX.x), top: pct(LEGACY_FACE_BOX.y), width: pct(LEGACY_FACE_BOX.width), height: pct(LEGACY_FACE_BOX.height) }}
            resizeMode="cover"
          />
        )}
        <Image
          source={{ uri: `data:${front.contentType};base64,${front.data}` }}
          style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
          resizeMode="stretch"
        />
      </View>
      <Text style={{ color: color.sub, fontSize: 12 }}>IC の記録から組み立てた表示です(地紋などのデザインは省略しています)。</Text>
    </View>
  );
}

const box = (b: { x: number; y: number; width: number; height: number }) =>
  ({ position: "absolute", left: pct(b.x), top: pct(b.y), width: pct(b.width), height: pct(b.height) }) as const;

function Labels({ labels, width }: { labels: CardLabel[]; width: number }) {
  return labels.map((l) => (
    <View key={l.ja} style={{ position: "absolute", left: pct(l.x), top: pct(l.y) }}>
      <Text style={{ fontSize: width * (l.size ?? LABEL_SIZE), color: "#4a5a4a" }}>{l.ja}</Text>
      {l.en && <Text style={{ fontSize: width * LABEL_EN_SIZE, lineHeight: width * LABEL_EN_SIZE * 1.15, color: "#4a5a4a" }}>{l.en}</Text>}
    </View>
  ));
}

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
  const [width, setWidth] = useState(0);
  const { labels, values } = gen2FaceTexts(fields, {
    kind,
    cardNumber: cardNumber ?? null,
    statusIsCode: isStatusCode(fields.statusOfResidence),
    workRestrictionLabel: (c) => WORK_RESTRICTION_LABEL[c as keyof typeof WORK_RESTRICTION_LABEL] ?? null,
    nationalityLabel: nationalityName,
  });
  const uri = (img: ImageData) => `data:${img.contentType};base64,${img.data}`;
  return (
    <View style={{ gap: 4 }}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ width: "100%", aspectRatio: 85.6 / 54, backgroundColor: "#edf5e9", borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: color.border }}
      >
        {GEN2_BANDS.map((b, i) => (
          <View key={i} style={{ ...box(b), backgroundColor: "#d7e8f3" }} />
        ))}
        {width > 0 && <Labels labels={labels} width={width} />}
        {width > 0 &&
          values.map((t) => (
            <Text key={`${t.x}-${t.y}`} numberOfLines={1} style={{ position: "absolute", left: pct(t.x), top: pct(t.y), fontSize: width * t.size, color: "#111", fontWeight: "600" }}>
              {t.text}
            </Text>
          ))}
        {name && <Image source={{ uri: uri(name) }} style={box(GEN2_NAME_BOX)} resizeMode="contain" />}
        {address && <Image source={{ uri: uri(address) }} style={box(GEN2_ADDRESS_BOX)} resizeMode="contain" />}
        {face && <Image source={{ uri: uri(face) }} style={box(GEN2_FACE_BOX)} resizeMode="cover" />}
      </View>
      <Text style={{ color: color.sub, fontSize: 12 }}>IC の記録(文字情報と氏名・住居地・顔の画像)から組み立てた表示です。配置は目安で、地紋などのデザインは省略しています。</Text>
    </View>
  );
}
