/**
 * Rendu PDF du document (pdfkit, JS pur). Fonction pure : un titre, un texte figé
 * à la séquence `seq`, un PDF. Exécutée dans un worker thread en production pour
 * ne pas bloquer la boucle d'événements du serveur temps réel.
 *
 * La mise en forme de l'éditeur (FORMATS : gras, italique, souligné, 3 polices,
 * 4 tailles) est reproduite avec les 12 polices standard de pdfkit, sans fichier
 * de police. Limite assumée : encodage WinAnsi (accents français compris) ; les
 * caractères hors de cet encodage (emoji…) ne s'affichent pas.
 */
import type { Segment } from "@editeur/shared";
import PDFDocument from "pdfkit";

const BASE_SIZE = 11;
/** Mêmes rapports que les tailles de Quill (0.75em, 1.5em, 2.5em). */
const SIZES: Record<string, number> = { small: 0.75, large: 1.5, huge: 2.5 };
const FAMILIES: Record<string, [regular: string, bold: string, italic: string, boldItalic: string]> = {
  sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  monospace: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

export function fontFor(attributes: Segment["attributes"] = {}) {
  const family = FAMILIES[String(attributes.font)] ?? FAMILIES.sans!;
  const bold = attributes.bold === true;
  const italic = attributes.italic === true;
  return {
    font: family[(bold ? 1 : 0) + (italic ? 2 : 0)]!,
    size: BASE_SIZE * (SIZES[String(attributes.size)] ?? 1),
    underline: attributes.underline === true,
  };
}

export interface RenderInput {
  title: string;
  /** Texte brut (sert si `delta` est absent). */
  text: string;
  /** Texte mis en forme, figé à la même séquence que `text`. */
  delta?: Segment[];
  seq: number;
  /** Date de génération (ms epoch), affichée en pied de page. */
  generatedAt: number;
}

export function renderPdf(input: RenderInput, options: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 56,
      compress: options.compress ?? true,
      info: { Title: input.title, Subject: `seq ${input.seq}`, Creator: "Editeur partage" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(18).text(input.title);
    doc
      .moveDown(0.3)
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#666666")
      .text(`Version ${input.seq} - générée le ${new Date(input.generatedAt).toISOString().replace("T", " ").slice(0, 19)} UTC`);
    doc.moveDown().fillColor("#000000");
    const segments = input.delta?.length ? input.delta : [{ insert: input.text }];
    segments.forEach((segment, i) => {
      const { font, size, underline } = fontFor(segment.attributes);
      doc.font(font).fontSize(size).text(segment.insert, { align: "left", underline, continued: i < segments.length - 1 });
    });
    doc.end();
  });
}
