import { ImageResponse } from "next/og";
import { getScribe } from "@/lib/scribe";

export const alt = "Scribe blog post";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type Props = {
  params: { locale: string; slug: string };
};

function getTitle(slug: string, locale: string): string {
  const scribe = getScribe();
  const en = scribe.blog.get(slug);
  if (!en) return "Scribe";
  const post = scribe.blog.translation(en, locale) ?? en;
  return post.frontmatter.title;
}

export default function OpengraphImage({ params }: Props) {
  const title = getTitle(params.slug, params.locale);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#ffffff",
          color: "#171717",
          padding: 80,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              background: "#171717",
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 32,
              fontWeight: 600,
            }}
          >
            S
          </div>
          <div style={{ fontSize: 36, fontWeight: 600 }}>Scribe</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 26, color: "#a3a3a3" }}>Blog</div>
          <div style={{ fontSize: 60, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
            {title}
          </div>
        </div>

        <div style={{ fontSize: 26, color: "#a3a3a3" }}>scribe.genlook.app</div>
      </div>
    ),
    size,
  );
}
