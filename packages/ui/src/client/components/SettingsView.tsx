import * as React from "react";
import { ArrowLeft, Cpu, FolderOpen, Moon, Puzzle, RefreshCw, SlidersHorizontal, Sun } from "lucide-react";
import type {
  AdapterSummary,
  AppSettings,
  DriverSummary,
  LanguageCode,
  ThemeMode,
} from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api } from "@/lib/api";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface SettingsViewProps {
  initialDriver?: string;
  settings: AppSettings;
  adapters: AdapterSummary[];
  drivers: DriverSummary[];
  refreshing: boolean;
  t: I18nMessages;
  onBack: () => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onRefreshCapabilities: () => Promise<void>;
}

type SettingsTab = "general" | "adapters" | "drivers";

export function SettingsView({
  settings, initialDriver,
  adapters,
  drivers,
  refreshing,
  t,
  onBack,
  onUpdateSettings,
  onRefreshCapabilities,
}: SettingsViewProps) {
  const [tab, setTab] = React.useState<SettingsTab>(initialDriver ? "drivers" : "general");
  const [execDrafts, setExecDrafts] = React.useState<Record<string, string>>(settings.driverExecutables);

  React.useEffect(() => {
    setExecDrafts(settings.driverExecutables);
  }, [settings.driverExecutables]);

  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState("");
  async function save(patch: Partial<AppSettings>) {
    setSaving(true);
    setFailure("");
    try { await onUpdateSettings(patch); }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  React.useEffect(() => {
    if (initialDriver) document.querySelector<HTMLElement>('[data-testid="driver-card-' + initialDriver + '"] input')?.focus();
  },[initialDriver]);

  const toggleAdapter = async (id: string, currentlyEnabled: boolean) => {
    const next = new Set(settings.disabledAdapters);
    if (currentlyEnabled) next.add(id);
    else next.delete(id);
    await save({ disabledAdapters: [...next] });
  };

  const saveExecutable = async (id: string, value: string) => {
    const next = { ...settings.driverExecutables };
    const trimmed = value.trim();
    if (trimmed) next[id] = trimmed;
    else delete next[id];
    await save({ driverExecutables: next });
  };

  const isMac = api.platform === "darwin";

  return (
    <div data-testid="settings-view" className="flex h-full w-full overflow-hidden bg-[var(--bg-app)]">
      {/* Left settings navigation */}
      <aside className="flex h-full w-[224px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] select-none">
        <div
          className={cn(
            "cv-drag flex h-11 items-center border-b border-[var(--border-subtle)] pr-3",
            isMac ? "pl-[76px]" : "pl-2.5",
          )}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            data-testid="settings-back-btn"
            className="cv-no-drag gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{t.back}</span>
          </Button>
        </div>

        <nav className="flex flex-col gap-0.5 p-2">
          {(
            [
              { id: "general", label: t.settingsGeneral, icon: SlidersHorizontal },
              { id: "adapters", label: t.settingsAdapters, icon: Puzzle },
              { id: "drivers", label: t.settingsDrivers, icon: Cpu },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`settings-nav-${item.id}`}
                onClick={() => setTab(item.id)}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors cursor-pointer",
                  active
                    ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Right settings content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "cv-drag flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] pl-6",
            isMac ? "pr-6" : "pr-[148px]",
          )}
        >
          <span className="text-[13px] font-medium text-[var(--text-primary)]">
            {tab === "general" ? t.settingsGeneral : tab === "adapters" ? t.settingsAdapters : t.settingsDrivers}
          </span>
          {tab === "drivers" && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void onRefreshCapabilities()}
              disabled={refreshing}
              className="cv-no-drag gap-1.5"
            >
              <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
              <span>{t.refresh}</span>
            </Button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-7">
          <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6">
            {failure && <p role="alert" className="text-sm text-red-500">{failure}</p>}
            {tab === "general" && (
              <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                {/* Appearance */}
                <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                  <span className="text-[13px] font-medium text-[var(--text-primary)]">{t.appearance}</span>
                  <div
                    role="radiogroup"
                    aria-label={t.appearance}
                    className="inline-flex items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5"
                  >
                    {(
                      [
                        { id: "light" as ThemeMode, label: t.themeLight, icon: Sun },
                        { id: "dark" as ThemeMode, label: t.themeDark, icon: Moon },
                      ] as const
                    ).map((opt) => {
                      const Icon = opt.icon;
                      const active = settings.theme === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          data-testid={`theme-${opt.id}`}
                          onClick={() => void save({ theme: opt.id })}
                          className={cn(
                            "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors cursor-pointer",
                            active
                              ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                          )}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          <span>{opt.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Language */}
                <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                  <span className="text-[13px] font-medium text-[var(--text-primary)]">{t.language}</span>
                  <div
                    role="radiogroup"
                    aria-label={t.language}
                    className="inline-flex items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5"
                  >
                    {(
                      [
                        { id: "zh-CN" as LanguageCode, label: t.langZh },
                        { id: "en" as LanguageCode, label: t.langEn },
                      ] as const
                    ).map((opt) => {
                      const active = settings.language === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          data-testid={`lang-${opt.id}`}
                          onClick={() => void save({ language: opt.id })}
                          className={cn(
                            "inline-flex h-7 items-center rounded-md px-3 text-[12.5px] font-medium transition-colors cursor-pointer",
                            active
                              ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                          )}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {tab === "adapters" && (
              <div className="flex flex-col gap-2.5">
                {adapters.map((adapter) => (
                  <div
                    key={adapter.id}
                    data-testid={`adapter-card-${adapter.id}`}
                    className="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3.5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <AgentGlyph agent={adapter.id} className="text-[var(--text-secondary)]" />
                        <span className="text-[13.5px] font-medium text-[var(--text-primary)]">
                          {agentLabel(adapter.id)}
                        </span>
                      </div>

                      <button
                        type="button"
                        disabled={saving}
                        role="switch"
                        aria-checked={adapter.enabled}
                        data-testid={`adapter-toggle-${adapter.id}`}
                        onClick={() => void toggleAdapter(adapter.id, adapter.enabled)}
                        className={cn(
                          "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors cursor-pointer",
                          adapter.enabled
                            ? "border-[#3ecf8e]/35 bg-[#3ecf8e]/10 text-[#3ecf8e]"
                            : "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--text-tertiary)]",
                        )}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            adapter.enabled ? "bg-[#3ecf8e]" : "bg-[var(--status-muted)]",
                          )}
                        />
                        <span>{adapter.enabled ? t.enabled : t.disabled}</span>
                      </button>
                    </div>

                    <details className="cv-settings-details">
                      <summary>{t.versionInstall} · {t.builtin} {adapter.packageVersion}</summary>
                      <dl>
                        <dt>{t.adapterVersion}</dt><dd>{adapter.packageVersion ?? "—"}</dd>
                        <dt>{t.formats}</dt><dd>{adapter.supportedVersions.join(", ") || "—"}</dd>
                        <dt>{t.abilities}</dt><dd>{[adapter.capabilities.import && t.import, adapter.capabilities.export && t.exportBundle,
                          adapter.capabilities.nativeResume && t.nativeCli].filter(Boolean).join(" · ")}</dd>
                        <dt>CLI</dt><dd>{drivers.find(driver => driver.id === adapter.id)?.version || t.unavailable}
                          <button type="button" className="ml-2 text-[var(--accent-text)]" onClick={() => {
                            setTab("drivers");
                            requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="driver-card-' + adapter.id + '"] input')?.focus());
                          }}>{t.driverConfig}</button></dd>
                      </dl>
                      <p>{t.manageDistribution}</p>
                      <div className="mt-2 flex gap-2">{[t.addAdapter,t.updateAdapter,t.changeVersion,t.removeAdapter].map(label =>
                        <Button key={label} size="xs" variant="outline" disabled>{label}</Button>)}</div>
                    </details>
                  </div>
                ))}
              </div>
            )}

            {tab === "drivers" && (
              <div className="flex flex-col gap-3">
                {drivers.map((driver) => {
                  const draft = execDrafts[driver.id] ?? "";
                  return (
                    <div
                      key={driver.id}
                      data-testid={`driver-card-${driver.id}`}
                      className="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-[13.5px] font-medium text-[var(--text-primary)]">
                          <AgentGlyph agent={driver.id} className="text-[var(--text-secondary)]" />
                          <span>{agentLabel(driver.id)}</span>
                        </div>
                        <div className="flex items-center gap-2 font-mono text-[11.5px]">
                          <span className={driver.available ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]"}>
                            {driver.version ?? t.unavailable}
                          </span>
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              driver.available ? "bg-[#3ecf8e]" : "bg-[var(--status-muted)]",
                            )}
                          />
                        </div>
                      </div>

                      {/* Executable path override */}
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={draft}
                          onChange={(e) => setExecDrafts((prev) => ({ ...prev, [driver.id]: e.target.value }))}
                          placeholder={driver.executablePath ?? t.autoDetected}
                          aria-label={`${agentLabel(driver.id)} ${t.executablePath}`}
                          className="h-7 font-mono text-[11.5px]"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          className="h-7 shrink-0"
                          onClick={async () => {
                            const picked = await api
                              .pickExecutable(draft || driver.executablePath || undefined)
                              .catch(() => null);
                            if (picked) {
                              setExecDrafts((prev) => ({ ...prev, [driver.id]: picked }));
                              await saveExecutable(driver.id, picked);
                            }
                          }}
                        >
                          <FolderOpen className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="h-7 shrink-0"
                          onClick={() => void saveExecutable(driver.id, draft)}
                        >
                          {t.apply}
                        </Button>
                      </div>

                      {/* Discovered models */}
                      <div className="flex flex-col gap-1.5">
                        <span className="font-mono text-[11px] text-[var(--text-tertiary)]">
                          {t.modelsCount(driver.models.length)}
                        </span>
                        {driver.models.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {driver.models.slice(0, 12).map((model) => (
                              <span
                                key={model.id}
                                title={model.id}
                                className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]"
                              >
                                {model.label}
                              </span>
                            ))}
                            {driver.models.length > 12 && (
                              <span className="px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-tertiary)]">
                                +{driver.models.length - 12}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
