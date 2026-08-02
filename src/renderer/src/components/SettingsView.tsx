import { useEffect, useState } from 'react'
import type { AppSettings, DetectionResult } from '../../../shared/types'
import { useAppStore } from '../store'

function StoreLoginRow({
  store,
  label,
  loggedIn,
  onLoggedIn
}: {
  store: 'gog' | 'epic' | 'amazon'
  label: string
  loggedIn: boolean
  onLoggedIn: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function login(): Promise<void> {
    setBusy('login')
    setError(null)
    try {
      // A window opens and closes itself the moment login completes - the code is read
      // straight off the redirect, nothing to copy/paste.
      if (store === 'gog') await window.api.loginGog()
      else if (store === 'epic') await window.api.loginEpic()
      else await window.api.loginAmazon()
      onLoggedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function logout(): Promise<void> {
    setBusy('logout')
    setError(null)
    try {
      if (store === 'gog') await window.api.logoutGog()
      else if (store === 'epic') await window.api.logoutEpic()
      else await window.api.logoutAmazon()
      onLoggedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="client-status-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          <span className={`status-dot ${loggedIn ? 'on' : 'off'}`} />
          {label}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {loggedIn ? (
            <button className="btn" disabled={!!busy} onClick={() => void logout()}>
              {busy === 'logout' ? 'Logging out…' : 'Logout'}
            </button>
          ) : (
            <button className="btn" disabled={!!busy} onClick={() => void login()}>
              {busy === 'login' ? 'Waiting for login…' : 'Login'}
            </button>
          )}
        </div>
      </div>
      {error && <span style={{ color: 'var(--bad)', fontSize: 12 }}>{error}</span>}
    </div>
  )
}

function StatusRow({ label, on, detail }: { label: string; on: boolean; detail?: string }): React.JSX.Element {
  return (
    <div className="client-status-row">
      <span>
        <span className={`status-dot ${on ? 'on' : 'off'}`} />
        {label}
      </span>
      <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
        {on ? detail ?? 'Detected' : 'Not found'}
      </span>
    </div>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label className="client-status-row toggle-row">
      <span>
        <div>{label}</div>
        <div className="hint">{hint}</div>
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function SettingsView({ detection }: { detection: DetectionResult | null }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const authStatus = useAppStore((s) => s.authStatus)
  const refreshAuthStatus = useAppStore((s) => s.refreshAuthStatus)
  const [form, setForm] = useState<AppSettings | null>(settings)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void refreshAuthStatus()
  }, [refreshAuthStatus])

  // The scale slider previews live by writing straight to the DOM (see below) - if the
  // user leaves this page without hitting Save, put the real saved value back so the
  // rest of the app doesn't stay visually scaled to a setting that was never committed.
  useEffect(() => {
    return () => {
      document.documentElement.style.zoom = String(settings?.uiScale ?? 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!settings) return <div>Loading…</div>
  const current = form ?? settings

  const update = (patch: Partial<AppSettings>): void => setForm({ ...current, ...patch })

  return (
    <div className="settings-page">
      <h1>Settings</h1>

      <div>
        <div className="section-label" style={{ marginBottom: 10 }}>
          Detected clients
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <StatusRow
            label="Steam"
            on={!!detection?.steam.present}
            detail={detection?.steam.present ? `${detection.steam.variant} · ${detection.steam.root ?? ''}` : undefined}
          />
          <StatusRow
            label="Heroic"
            on={!!detection?.heroic.present}
            detail={detection?.heroic.present ? `${detection.heroic.variant} · ${detection.heroic.configDir ?? ''}` : undefined}
          />
          <StatusRow label="legendary (Epic backend)" on={!!detection?.heroic.legendary} />
          <StatusRow label="gogdl (GOG backend)" on={!!detection?.heroic.gogdl} />
          <StatusRow label="nile (Amazon backend)" on={!!detection?.heroic.nile} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="section-label">Store accounts</div>
        <span className="hint">
          Logs in through Heroic&apos;s own backends (gogdl/legendary/nile) - the same accounts Heroic
          itself would use. Steam isn&apos;t listed here: its login only happens in the Steam client
          itself, the same as installing and launching Steam games in this app.
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <StoreLoginRow store="gog" label="GOG" loggedIn={!!authStatus?.gog} onLoggedIn={refreshAuthStatus} />
          <StoreLoginRow
            store="epic"
            label="Epic Games"
            loggedIn={!!authStatus?.epic}
            onLoggedIn={refreshAuthStatus}
          />
          <StoreLoginRow
            store="amazon"
            label="Amazon Games"
            loggedIn={!!authStatus?.amazon}
            onLoggedIn={refreshAuthStatus}
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="section-label">Display</div>
        <div className="field">
          <label>UI scale ({Math.round(current.uiScale * 100)}%)</label>
          <input
            type="range"
            min={1}
            max={2}
            step={0.1}
            value={current.uiScale}
            onChange={(e) => {
              const value = Number(e.target.value)
              update({ uiScale: value })
              // Preview immediately rather than waiting for Save - a scale change is
              // exactly the kind of thing you want to see before committing to it.
              document.documentElement.style.zoom = String(value)
            }}
          />
          <span className="hint">
            Makes text, covers and buttons bigger - useful when the app is on a TV viewed from
            a couch. 100% is normal size.
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="section-label">Stores</div>
        <span className="hint">Steam and GOG are always shown. Turn these on if you use them too.</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ToggleRow
            label="Epic Games"
            hint="Show Epic titles from your Heroic library"
            checked={current.enabledStores.epic}
            onChange={(v) => update({ enabledStores: { ...current.enabledStores, epic: v } })}
          />
          <ToggleRow
            label="Amazon Games"
            hint="Show Amazon titles from your Heroic library"
            checked={current.enabledStores.amazon}
            onChange={(v) => update({ enabledStores: { ...current.enabledStores, amazon: v } })}
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="section-label">Cover art</div>
        <div className="field">
          <label>SteamGridDB API key</label>
          <input
            type="password"
            value={current.steamGridDbApiKey}
            onChange={(e) => update({ steamGridDbApiKey: e.target.value })}
            placeholder="Paste your SteamGridDB API key"
          />
          <span className="hint">Used to fetch cover/hero art for your whole library.</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="section-label">Steam library (optional)</div>
        <div className="field">
          <label>Steam Web API key</label>
          <input
            type="password"
            value={current.steamWebApiKey}
            onChange={(e) => update({ steamWebApiKey: e.target.value })}
            placeholder="Only needed to show owned-but-uninstalled Steam games"
          />
        </div>
        <div className="field">
          <label>SteamID64</label>
          <input
            value={current.steamId64}
            onChange={(e) => update({ steamId64: e.target.value })}
            placeholder="Auto-detected from your Steam login when left blank"
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="section-label">Installs</div>
        <div className="field">
          <label>Default install location</label>
          <input
            value={current.defaultInstallBasePath}
            onChange={(e) => update({ defaultInstallBasePath: e.target.value })}
          />
          <span className="hint">
            New installs are placed under here in per-store subfolders (GOG/, Epic/, Amazon/).
          </span>
        </div>
      </div>

      <div>
        <button
          className="btn btn-primary"
          onClick={async () => {
            await saveSettings(current)
            setSaved(true)
            setTimeout(() => setSaved(false), 1500)
          }}
        >
          {saved ? 'Saved ✓' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}
