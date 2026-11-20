import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, ArrowRight, ChevronDown, ChevronRight, Terminal } from "lucide-react";
import type { ChatMessage, ToolActivity, UiSession } from "../../shared/types.js";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";

interface StreamingState {
  text: string;
  tools: ToolActivity[];
}

interface ThreadViewProps {
  session: UiSession;
  streaming: StreamingState | null;
  onInspectHandoff: () => void;
}

function ToolTrace({ tools }: { tools: ToolActivity[] }) {
  const [open, setOpen] = React.useState(false);
  if (tools.length === 0) return null;

  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-[#0e0f12] px-2 py-1 font-mono text-[11.5px] text-[#8a8f98] transition-colors hover:border-white/[0.12] hover:text-[#d0d6e0] cursor-pointer"
      >
        <Terminal className="h-3 w-3" />
        <span>
          {tools.length} {tools.length === 1 ? "tool" : "tools"}
        </span>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1 border-l border-white/[0.08] pl-3">
          {tools.map((tool, index) => (
            <div key={`${tool.name}-${index}`} className="flex items-center gap-2 font-mono text-[11.5px]">
              <span className="text-[#c8cdd6]">{tool.name}</span>
              <span className="text-[#5b6069]">{tool.state}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div data-testid={`message-user-${message.id}`} className="flex justify-end">
        <div className="max-w-[82%] rounded-xl border border-white/[0.08] bg-[#14161a] px-3.5 py-2.5 text-[14px] leading-relaxed text-[#f7f8f8] whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div data-testid={`message-assistant-${message.id}`} className="group flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[11.5px] text-[#6d727c]">
        <AgentGlyph agent={message.agent ?? ""} className="h-3.5 w-3.5 text-[#8a8f98]" />
        <span className="font-medium text-[#b8bec8]">{agentLabel(message.agent ?? "")}</span>
        {message.model && <span className="font-mono text-[11px] text-[#6d727c]">{message.model}</span>}
      </div>

      <div className="pl-[22px]">
        {message.tools && message.tools.length > 0 && <ToolTrace tools={message.tools} />}

        {message.content && (
          <div className="cv-prose">
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
          </div>
        )}

        {message.error && (
          <div
            role="alert"
            data-testid="message-error"
            className={cn(
              "mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]",
              message.aborted
                ? "border-white/[0.09] bg-[#121316] text-[#8a8f98]"
                : "border-[#e5484d]/30 bg-[#e5484d]/[0.07] text-[#ff878b]",
            )}
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <span className="font-mono text-[11.5px] font-medium">{message.error.code}</span>
              <span className="mx-1.5 opacity-40">·</span>
              <span>{message.error.message}</span>
            </div>
          </div>
        )}

        {message.usage && (
          <div className="mt-2 font-mono text-[11px] text-[#555a63]">
            {[
              message.usage.input !== undefined ? `${message.usage.input} in` : null,
              message.usage.output !== undefined ? `${message.usage.output} out` : null,
              message.usage.cachedInput !== undefined ? `${message.usage.cachedInput} cached` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadView({ session, streaming, onInspectHandoff }: ThreadViewProps) {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session.messages.length, streaming?.text.length, streaming?.tools.length]);

  const handoff = session.handoff;

  return (
    <div className="flex-1 overflow-y-auto" data-testid="thread-view">
      <div className="mx-auto flex w-full max-w-[740px] flex-col gap-6 px-6 py-6">
        {handoff && (
          <button
            type="button"
            onClick={onInspectHandoff}
            data-testid="handoff-strip"
            className="flex min-h-9 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-white/[0.08] bg-[#0e0f12] px-3 py-2 text-[12px] text-[#8a8f98] transition-colors hover:border-white/[0.14] hover:text-[#d0d6e0] cursor-pointer"
          >
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono">
              <span className="whitespace-nowrap text-[#d0d6e0]">{agentLabel(handoff.from)}</span>
              <ArrowRight className="h-3 w-3 shrink-0 text-[#5b6069]" />
              <span className="whitespace-nowrap text-[#d0d6e0]">{agentLabel(handoff.to)}</span>
              <span className="text-[#555a63]">·</span>
              <span className="whitespace-nowrap">{handoff.statistics.turns} turns</span>
              {session.bundlePending && (
                <>
                  <span className="text-[#555a63]">·</span>
                  <span className="whitespace-nowrap text-[#5e6ad2]">ready</span>
                </>
              )}
            </span>
            <span className="flex items-center gap-2.5 font-mono text-[11.5px] whitespace-nowrap">
              <span className={handoff.losses.dropped > 0 ? "text-[#ff6b70]" : "text-[#6d727c]"}>
                {handoff.losses.dropped} dropped
              </span>
              <span className={handoff.losses.downgraded > 0 ? "text-[#e5a93b]" : "text-[#6d727c]"}>
                {handoff.losses.downgraded} downgraded
              </span>
            </span>
          </button>
        )}

        {session.messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}

        {streaming && (
          <div data-testid="streaming-message" className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[11.5px] text-[#8a8f98]">
              <AgentGlyph agent={session.agent} className="h-3.5 w-3.5 text-[#5e6ad2] animate-pulse" />
              <span className="font-medium text-[#d0d6e0]">{agentLabel(session.agent)}</span>
              {session.model && <span className="font-mono text-[11px] text-[#6d727c]">{session.model}</span>}
            </div>
            <div className="pl-[22px]">
              {streaming.tools.length > 0 && <ToolTrace tools={streaming.tools} />}
              {streaming.text ? (
                <div className="cv-prose">
                  <Markdown remarkPlugins={[remarkGfm]}>{streaming.text}</Markdown>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 py-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#5e6ad2] animate-pulse" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#5e6ad2]/60 animate-pulse [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#5e6ad2]/30 animate-pulse [animation-delay:300ms]" />
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
