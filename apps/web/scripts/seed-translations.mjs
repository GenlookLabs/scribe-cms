import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import Database from "better-sqlite3";
import { loadConfigSync } from "scribe-cms";

const config = loadConfigSync({
  configPath: path.join(process.cwd(), "scribe.config.ts"),
});

const frenchPages = {
  home: {
    frontmatter: {
      title: "Contenu MDX typé pour sites multilingues",
      description:
        "Fichiers source anglais sur disque, traductions locales dans SQLite, schémas Zod et une API runtime agnostique.",
    },
    body: `Scribe valide le frontmatter contre votre schéma Zod, traduit les champs traduisibles avec un LLM et sert le contenu via une API runtime typée.

- **Contenu anglais basé sur des fichiers** — un fichier \`.mdx\` par document, versionné dans git.
- **Traductions SQLite** — seules les pages modifiées sont retraduites.
- **Runtime typé** — \`createScribe(config)\` vous donne des accesseurs typés par type de contenu.`,
  },
  "getting-started": {
    frontmatter: {
      title: "Premiers pas",
      description:
        "Installez scribe-cms, définissez votre schéma, rédigez du contenu, validez et lisez-le au runtime.",
    },
    body: `## 1. Installation

Ajoutez scribe-cms et ses dépendances peer à votre projet.

## 2. Créer scribe.config.ts

Définissez les types de contenu avec des schémas Zod à la racine du projet. Utilisez \`field.translatable()\` pour les champs à traduire, \`field.structural()\` pour les champs EN uniquement, et \`field.relation()\` pour les références entre documents.

## 3. Rédiger du contenu

Créez des fichiers \`.mdx\` sous \`content/\`. Le nom de fichier est le slug anglais. Le frontmatter est validé contre votre schéma au chargement.

## 4. Valider

Exécutez \`scribe validate\` avant votre build pour détecter les erreurs de schéma, les relations cassées et les incohérences du store de traductions.

## 5. Lire au runtime

Importez \`createScribe\` depuis \`scribe-cms/runtime\`, passez votre config et utilisez des accesseurs typés comme \`scribe.blog.list()\` et \`scribe.blog.resolve(slug, locale)\`.

Consultez la page [Exemples](/examples) pour des extraits à copier-coller.`,
  },
};

const frenchExamples = {
  install: {
    title: "Installation",
    caption: "Ajoutez scribe-cms à tout projet Node 20+.",
  },
  "scribe-config": {
    title: "Configuration",
    caption: "Définissez les types de contenu avec Zod — champs traduisibles, structurels et relations.",
  },
  "content-file": {
    title: "Fichier de contenu",
    caption: "Un fichier .mdx par document — le nom de fichier est le slug anglais.",
  },
  runtime: {
    title: "Runtime",
    caption: "Lisez le contenu avec un client typé — list, resolve et relations.",
  },
  "translate-cli": {
    title: "CLI",
    caption: "Validez le contenu avant les builds et traduisez les pages obsolètes avec Gemini.",
  },
};

function hashTranslation(frontmatter, body) {
  return createHash("sha256")
    .update(JSON.stringify({ frontmatter, body }), "utf8")
    .digest("hex");
}

function readMdx(relativePath) {
  const filePath = path.join(config.rootDir, relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  const { data: frontmatter, content: body } = matter(source);
  return { frontmatter, body };
}

function translatablePageFrontmatter(frontmatter) {
  return {
    title: frontmatter.title,
    description: frontmatter.description,
  };
}

function translatableExampleFrontmatter(frontmatter) {
  return {
    title: frontmatter.title,
    caption: frontmatter.caption,
  };
}

fs.mkdirSync(path.dirname(config.storePath), { recursive: true });
const db = new Database(config.storePath);

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS translations (
    content_type TEXT NOT NULL,
    en_slug TEXT NOT NULL,
    locale TEXT NOT NULL,
    slug TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL,
    body TEXT NOT NULL,
    en_hash TEXT NOT NULL,
    translated_at TEXT NOT NULL,
    model TEXT NOT NULL,
    PRIMARY KEY (content_type, en_slug, locale)
  );
  CREATE INDEX IF NOT EXISTS idx_translations_type_locale
    ON translations(content_type, locale);
`);

const upsert = db.prepare(
  `INSERT INTO translations (
    content_type, en_slug, locale, slug, frontmatter_json, body, en_hash, translated_at, model
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(content_type, en_slug, locale) DO UPDATE SET
    slug = excluded.slug,
    frontmatter_json = excluded.frontmatter_json,
    body = excluded.body,
    en_hash = excluded.en_hash,
    translated_at = excluded.translated_at,
    model = excluded.model`,
);

let updated = 0;

for (const [slug, french] of Object.entries(frenchPages)) {
  const { frontmatter, body } = readMdx(path.join("pages", `${slug}.mdx`));
  const enHash = hashTranslation(translatablePageFrontmatter(frontmatter), body);
  const existing = db
    .prepare(
      "SELECT en_hash FROM translations WHERE content_type = ? AND en_slug = ? AND locale = ?",
    )
    .get("page", slug, "fr");

  if (existing?.en_hash === enHash) {
    continue;
  }

  upsert.run(
    "page",
    slug,
    "fr",
    slug,
    JSON.stringify({
      ...french.frontmatter,
      installCommand: frontmatter.installCommand,
    }),
    french.body,
    enHash,
    new Date().toISOString(),
    "seed",
  );
  updated++;
}

for (const [slug, french] of Object.entries(frenchExamples)) {
  const { frontmatter, body } = readMdx(path.join("examples", `${slug}.mdx`));
  const enHash = hashTranslation(translatableExampleFrontmatter(frontmatter), body);
  const existing = db
    .prepare(
      "SELECT en_hash FROM translations WHERE content_type = ? AND en_slug = ? AND locale = ?",
    )
    .get("example", slug, "fr");

  if (existing?.en_hash === enHash) {
    continue;
  }

  upsert.run(
    "example",
    slug,
    "fr",
    slug,
    JSON.stringify({
      ...french,
      language: frontmatter.language,
      order: frontmatter.order,
    }),
    body,
    enHash,
    new Date().toISOString(),
    "seed",
  );
  updated++;
}

db.close();

if (updated === 0) {
  console.log("French translations are up to date.");
} else {
  console.log(`Seeded or updated ${updated} French translation(s).`);
}
