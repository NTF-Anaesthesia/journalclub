// Loaded only when someone uploads a PDF. Text is extracted once, in the browser, and kept per page.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
const PAGE_MAX = 20000;
const TOTAL_MAX = 800000; // keeps the texts/{paper} document under Firestore's 1 MB limit

export async function extractPages(buffer) {
  const task = getDocument({ data: new Uint8Array(buffer) });
  const pdf = await task.promise;
  const pages = [];
  let total = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    let text = content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, PAGE_MAX);
    if (total + text.length > TOTAL_MAX) text = text.slice(0, Math.max(0, TOTAL_MAX - total));
    total += text.length;
    pages.push(text);
  }
  await task.destroy();
  return pages;
}
