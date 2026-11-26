import * as React from "react";
import type {I18nMessages} from "@/lib/i18n";

export const ReadingPage = React.createContext<{page:number; remember:(page:number) => void} | null>(null);

const PdfPreview = React.lazy(() => import("./PdfPreview"));
export function imageMime(type: string) {
  return /^image\/(?:\*|png|jpeg|gif|webp|avif|bmp|x-icon)$/i.test(type);
}

export function AssetPreview({url, type, label, t}: {url:string; type:string; label:string; t:I18nMessages}) {
  const [failed, setFailed] = React.useState(false);
  const [scheme, declared] = /^data:([^;,]+);base64,/i.exec(url) ?? [];
  const external = /^https?:\/\//i.test(url);
  if (failed || (!external && (!scheme || declared?.toLowerCase() !== type.toLowerCase()))) {
    return <p role="alert">{t.mediaFailed} · {label}</p>;
  }
  if (imageMime(type)) return <img alt={label} src={url} referrerPolicy="no-referrer"
    className="mx-auto max-h-[68vh] max-w-full object-contain" onError={() => setFailed(true)}/>;
  if (type.startsWith("video/")) return <video controls preload="metadata" src={url} className="mx-auto max-h-[68vh] max-w-full" onError={() => setFailed(true)}/>;
  if (type.startsWith("audio/")) return <audio controls src={url} onError={() => setFailed(true)}/>;
  if (type === "application/pdf") return <React.Suspense fallback={<p>{t.loading}</p>}><PdfPreview url={url} t={t}/></React.Suspense>;
  if (external && type === "text/uri-list") return <a className="break-all underline" href={url} target="_blank" rel="noreferrer">{url}</a>;
  return <p role="status">{t.noPreview} · {type}</p>;
}
