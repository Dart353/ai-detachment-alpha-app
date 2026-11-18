import { useEffect, useState, type JSX } from 'react'
import { Check, FileText, LayoutPanelLeft } from 'lucide-react'
import { Button, Modal, Toggle, type MenuItem } from './ui'
import { useApp } from '../store/app'
import { useRuntime } from '../store/runtime'
import {
  WORKBENCH_CAPTURES_DIR,
  WORKBENCH_FILE,
  WORKBENCH_RULES_FILE
} from '../../../shared/workbench'
import type { WorkbenchSetupState, Workspace } from '../../../shared/types'
import './WorkbenchSetup.css'

/**
 * The workspace menu's workbench entry: "Open workbench" once the folder has a
 * page, "Set up workbench…" (which asks first) until then.
 */
export function workbenchMenuItem(
  workspace: Pick<Workspace, 'id' | 'rootDir'>,
  iconSize?: number
): MenuItem {
  const hasPage = useRuntime.getState().workbench[workspace.rootDir]?.exists ?? false
  const icon = iconSize ? <LayoutPanelLeft size={iconSize} /> : undefined
  return hasPage
    ? {
        label: 'Open workbench',
        icon,
        divider: true,
        onClick: () => useApp.getState().openWorkbench(workspace.id)
      }
    : {
        label: 'Set up workbench…',
        icon,
        divider: true,
        onClick: () => useApp.getState().askWorkbenchSetup(workspace.id)
      }
}

/**
 * "Set up a workbench for <name>?" — says exactly what will be written and
 * that git never sees it, then does it. Mounted once in the app shell and
 * opened through `askWorkbenchSetup`.
 */
export function WorkbenchSetupDialog(): JSX.Element {
  const workspaceId = useApp((state) => state.workbenchSetupFor)
  const workspace = useApp((state) =>
    state.workspaces.find((candidate) => candidate.id === state.workbenchSetupFor)
  )
  const ask = useApp((state) => state.askWorkbenchSetup)
  const openWorkbench = useApp((state) => state.openWorkbench)
  const pushToast = useApp((state) => state.pushToast)

  const [state, setState] = useState<WorkbenchSetupState | null>(null)
  const [openPane, setOpenPane] = useState(true)
  const [replaceRules, setReplaceRules] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rootDir = workspace?.rootDir ?? null
  useEffect(() => {
    setState(null)
    setError(null)
    setReplaceRules(false)
    setOpenPane(true)
    if (!rootDir) return undefined
    let live = true
    void window.api?.workbenchState(rootDir).then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
    }
  }, [rootDir])

  const close = (): void => ask(null)

  const confirm = async (): Promise<void> => {
    if (!workspace) return
    setBusy(true)
    setError(null)
    const result = await window.api?.setupWorkbench(workspace.rootDir, replaceRules)
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      setError(result.error)
      return
    }
    close()
    if (openPane) openWorkbench(workspace.id)
    else pushToast(`Workbench set up for ${workspace.name}`)
  }

  const edited = state?.rules === 'modified'
  return (
    <Modal
      open={!!workspaceId && !!workspace}
      title={workspace ? `Set up a workbench for ${workspace.name}?` : 'Set up a workbench'}
      width={520}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || !state} onClick={() => void confirm()}>
            {busy ? 'Setting up…' : 'Set up workbench'}
          </Button>
        </>
      }
    >
      <div className="ada-wbs">
        <p className="ada-wbs-lede">
          Claude sessions in this folder will keep a live page of what they are doing and what
          they need from you. It opens in a pane, and you are told when a task is waiting on you.
        </p>

        <div className="ada-wbs-label">Adds</div>
        <ul className="ada-wbs-files">
          <li>
            <FileText size={13} aria-hidden />
            <span className="ada-wbs-path">{WORKBENCH_RULES_FILE}</span>
            <span className="ada-wbs-why">
              {state?.rules === 'outdated' ? 'updates the older rule' : 'tells Claude how'}
            </span>
          </li>
          <li>
            <FileText size={13} aria-hidden />
            <span className="ada-wbs-path">{WORKBENCH_FILE}</span>
            <span className="ada-wbs-why">{state?.page ? 'already there, kept' : 'the page'}</span>
          </li>
          <li>
            <FileText size={13} aria-hidden />
            <span className="ada-wbs-path">{WORKBENCH_CAPTURES_DIR}/</span>
            <span className="ada-wbs-why">screenshots and recordings</span>
          </li>
        </ul>

        <p className="ada-wbs-note">
          <Check size={13} aria-hidden className="ada-wbs-ok" />
          {state?.excluded === null ? (
            <span>This folder is not in a git repository, so there is nothing to keep out of commits.</span>
          ) : (
            <span>
              All three are kept out of git through <code>.git/info/exclude</code>, so your commits
              and your <code>.gitignore</code> stay untouched.
            </span>
          )}
        </p>

        {edited && (
          <div className="ada-wbs-row">
            <span>
              <strong>{WORKBENCH_RULES_FILE}</strong> has been edited by hand. Replace it with the
              current rule?
            </span>
            <Toggle checked={replaceRules} ariaLabel="Replace the edited rule" onChange={setReplaceRules} />
          </div>
        )}

        <div className="ada-wbs-row">
          <span>Open the workbench pane now</span>
          <Toggle checked={openPane} ariaLabel="Open the workbench pane now" onChange={setOpenPane} />
        </div>

        {error && (
          <p className="ada-wbs-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

export default WorkbenchSetupDialog
