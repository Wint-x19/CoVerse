import * as React from "react";
import {getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask} from "pdfjs-dist/legacy/build/pdf.mjs";
import { ReadingPage } from "./AssetPreview";
import worker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type {I18nMessages} from "@/lib/i18n";

GlobalWorkerOptions.workerSrc = worker;
export default function PdfPreview({url,t}: {url:string; t:I18nMessages}) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const [doc,setDoc] = React.useState<PDFDocumentProxy | null>(null);
  const saved = React.useContext(ReadingPage);
  const [page,setPage] = React.useState(saved?.page ?? 1);
  const navigate = (next:number) => {setPage(next); saved?.remember(next);};
  const [error,setError] = React.useState("");
  React.useEffect(() => {
    let active = true;
    let task: ReturnType<typeof getDocument> | undefined;
    try {
      const input = url.startsWith("data:") ? {data:Uint8Array.from(atob(url.slice(url.indexOf(",")+1)), char => char.charCodeAt(0))} : {url};
      const resources = new URL(import.meta.env.DEV ? "./node_modules/pdfjs-dist/" : "./pdf-resources/", document.baseURI).href;
      task = getDocument({...input,isEvalSupported:false,cMapUrl:resources+"cmaps/",cMapPacked:true,
        standardFontDataUrl:resources+"standard_fonts/",wasmUrl:resources+"wasm/"});
      task.promise.then(document => { if (active) {setDoc(document);setPage(current => Math.min(document.numPages,current));} }).catch(err => { if (active) setError(String(err.message)); });
    } catch (err) { setError(String(err)); }
    return () => { active = false; void task?.destroy(); };
  }, [url]);
  React.useEffect(() => {
    if (!doc) return;
    let active = true;
    let task: RenderTask | undefined;
    doc.getPage(page).then(async pdfPage => {
      if (!active || !canvas.current) return;
      const surface = canvas.current;
      const dimensions = pdfPage.getViewport({scale:1});
      const viewport = pdfPage.getViewport({scale:Math.min(1.5,4096 / Math.max(dimensions.width,dimensions.height))});
      surface.width = viewport.width; surface.height = viewport.height;
      task = pdfPage.render({canvas:surface,viewport});
      await task.promise;
      if (active) surface.dataset.renderedPage = String(page);
    }).catch(err => { if (active) setError(String(err.message)); });
    return () => { active = false; task?.cancel(); };
  }, [doc,page]);
  if (error) return <p role="alert">{t.mediaFailed} · {error}</p>;
  return <div>
    {doc ? <nav className="sticky top-0 flex justify-center gap-3 bg-[var(--bg-surface)] py-1 text-sm">
      <button type="button" disabled={page === 1} aria-label={t.previousPage} onClick={() => navigate(page-1)}>‹</button>
      <span>{page} / {doc.numPages}</span>
      <button type="button" disabled={page === doc.numPages} aria-label={t.nextPage} onClick={() => navigate(page+1)}>›</button>
    </nav> : <p>{t.loading}</p>}
    <canvas ref={canvas} aria-label={"PDF · " + page} className="mx-auto max-w-full"/>
  </div>;
}
