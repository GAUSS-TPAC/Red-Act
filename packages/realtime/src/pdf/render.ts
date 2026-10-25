/**
 * Rendu PDF du document (pdfkit, JS pur). Fonction pure : un titre, un texte figé
 * à la séquence `seq`, un PDF. Exécutée dans un worker thread en production pour
 * ne pas bloquer la boucle d'événements du serveur temps réel.
 *
 * Limite assumée : police standard Helvetica (encodage WinAnsi, accents français
 * compris) ; les caractères hors de cet encodage (emoji…) ne s'affichent pas.
 */
import PDFDocument from "pdfkit";

export interface RenderInput {
  title: string;
  text: string;
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
    doc.moveDown().fillColor("#000000").fontSize(11).text(input.text, { align: "left" });
    doc.end();
  });
}
