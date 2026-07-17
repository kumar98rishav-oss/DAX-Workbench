import { useState } from 'react'
import { X, Radio, Loader2, Check, AlertTriangle, MonitorSmartphone, Download } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button, IconButton } from '@/design-system/components'
import { testBridge, LOCAL_BRIDGE } from '@/infrastructure/desktop/desktop-client'
import '@/presentation/data/import-preview.css'
import './remote-bridge.css'

type Probe = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; machine?: string; models: number } | { state: 'fail'; reason: string }

/** Point Studio at a bridge running on someone else's machine. */
export function RemoteBridgeDialog() {
  const open = useApp((s) => s.remoteOpen)
  const toggle = useApp((s) => s.toggleRemote)
  const bridgeUrl = useApp((s) => s.bridgeUrl)
  const bridgeToken = useApp((s) => s.bridgeToken)
  const setBridge = useApp((s) => s.setBridge)

  const isLocal = bridgeUrl === LOCAL_BRIDGE
  const [host, setHost] = useState(() => (isLocal ? '' : bridgeUrl.replace(/^https?:\/\//, '').split(':')[0]))
  const [port, setPort] = useState(() => (isLocal ? '5177' : bridgeUrl.split(':')[2] || '5177'))
  const [token, setToken] = useState(bridgeToken ?? '')
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })

  if (!open) return null

  const url = `http://${host.trim()}:${port.trim() || '5177'}`
  const targetsAnotherMachine = !!host.trim() && !/^(127\.0\.0\.1|localhost)$/i.test(host.trim())
  // The single thing that makes this fail for most people, so say it before they try.
  const httpsBlocked = location.protocol === 'https:' && targetsAnotherMachine

  const test = async () => {
    setProbe({ state: 'testing' })
    const r = await testBridge(url, token)
    setProbe(r.ok ? { state: 'ok', machine: r.machine, models: r.models } : { state: 'fail', reason: r.reason })
  }

  const save = async () => {
    await setBridge(url, token.trim() || null)
  }

  const useLocal = async () => {
    await setBridge(LOCAL_BRIDGE, null)
  }

  return (
    <div className="impdlg__scrim" onMouseDown={(e) => e.target === e.currentTarget && toggle(false)}>
      <div className="impdlg impdlg--wide" role="dialog" aria-modal="true" aria-label="Remote connector">
        <div className="impdlg__head">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Radio size={20} style={{ color: 'var(--accent)' }} />
            <div>
              <div className="impdlg__title">Remote connector</div>
              <div className="impdlg__sub">Work on a Power BI Desktop report that's open on another machine.</div>
            </div>
          </div>
          <IconButton label="Close" onClick={() => toggle(false)}><X size={18} /></IconButton>
        </div>

        <div className="impdlg__body pbs-scroll">
          <ol className="rb__steps">
            <li>
              <b>Send them the bridge file</b> and have them open their report in Power BI Desktop.
              <a className="rb__grab" href="/download/BI-Design-Studio-Bridge.exe" download>
                <Download size={13} /> Download the bridge to send
              </a>
            </li>
            <li>
              <b>They double-click it</b> and, when it asks, choose{' '}
              <b>[2] This computer AND someone else's Studio</b>. (Windows may warn it's from an
              unknown publisher — <i>More info → Run anyway</i>.)
            </li>
            <li>
              The window then shows an <b>Address</b> and a <b>pairing token</b> — they send you both.
              The token is new every time and, without it, the bridge refuses every request from the
              network.
            </li>
            <li><b>Put them in here</b>, test, and connect.</li>
          </ol>

          <div className="rb__grid">
            <label className="dax-field">
              <span className="dax-field__label">Address</span>
              <input className="dax-input" placeholder="192.168.1.42" value={host} onChange={(e) => { setHost(e.target.value); setProbe({ state: 'idle' }) }} />
            </label>
            <label className="dax-field" style={{ maxWidth: 110 }}>
              <span className="dax-field__label">Port</span>
              <input className="dax-input" value={port} onChange={(e) => { setPort(e.target.value); setProbe({ state: 'idle' }) }} />
            </label>
            <label className="dax-field">
              <span className="dax-field__label">Pairing token</span>
              <input className="dax-input" placeholder="3c9691798b18…" value={token} onChange={(e) => { setToken(e.target.value); setProbe({ state: 'idle' }) }} />
            </label>
          </div>

          {httpsBlocked && (
            <div className="rb__note rb__note--warn">
              <AlertTriangle size={15} />
              <div>
                <b>This page is on HTTPS, so your browser will block a plain-HTTP address on another machine.</b>
                That's a browser rule, not a setting we can change. Two ways around it:
                <ul>
                  <li>
                    <b>Tunnel it</b> — on your machine run{' '}
                    <code>ssh -N -L {port || '5177'}:127.0.0.1:{port || '5177'} user@{host || '<their-ip>'}</code>,
                    then connect to <code>127.0.0.1</code> here instead. Encrypted, and no token needed.
                  </li>
                  <li><b>Or run Studio locally</b> over <code>http://localhost:5175</code>, where this restriction doesn't apply.</li>
                </ul>
              </div>
            </div>
          )}

          {probe.state === 'ok' && (
            <div className="rb__note rb__note--ok">
              <Check size={15} />
              <div>
                Reached <b>{probe.machine ?? 'the bridge'}</b> —{' '}
                {probe.models > 0
                  ? <>{probe.models} model{probe.models === 1 ? '' : 's'} open. Connect to pull it in.</>
                  : <>but no report is open in Power BI Desktop there yet.</>}
              </div>
            </div>
          )}
          {probe.state === 'fail' && (
            <div className="rb__note rb__note--fail"><AlertTriangle size={15} /><div>{probe.reason}</div></div>
          )}

          <div className="rb__note">
            <MonitorSmartphone size={15} />
            <div>
              While connected, everything — the model, previews, measures you push — runs against
              <b> their</b> machine, and their data travels your network in the clear. Only do this on
              a network you trust, and use the tunnel if you don't.
            </div>
          </div>
        </div>

        <div className="impdlg__foot">
          {!isLocal && (
            <button className="rb__revert" onClick={() => void useLocal()}>Back to this machine</button>
          )}
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => void test()} disabled={!host.trim() || probe.state === 'testing'}>
            {probe.state === 'testing' ? <Loader2 size={15} className="pbs-spin" /> : null} Test connection
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!host.trim()}>Connect</Button>
        </div>
      </div>
    </div>
  )
}
