import { ImageResponse } from "next/og";

export const alt = "Scribe — typed content for multilingual MDX sites";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
          }}
        >
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
          <div style={{ fontSize: 64, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
            Typed content for multilingual MDX sites
          </div>
          <div style={{ fontSize: 30, color: "#525252", lineHeight: 1.4 }}>
            MDX in git, translations in SQLite, schemas in Zod — no CMS server.
          </div>
        </div>

        <div style={{ fontSize: 26, color: "#a3a3a3" }}>scribe.genlook.app</div>
      </div>
    ),
    size,
  );
}
