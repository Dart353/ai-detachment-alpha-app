import { useEffect } from 'react'
import { useRemote } from '../store/remote'

/**
 * Keeps the remote store in step with main's viewer link. Mounted once from
 * the app shell.
 *
 * It asks for the current picture on mount — a change pushed before the
 * subscription existed would otherwise be missed until the next one — and then
 * follows main's pushes. Remote screens and output are NOT taken here: they
 * stream straight into the terminal that shows them, never through a store.
 *
 * A machine that disconnected this viewer is forgotten by main, so the next
 * status drops it anyway; clearing the selection on the notice itself spares
 * the user a frame of a pane that is already gone.
 */
export function useRemoteLink(): void {
  useEffect(() => {
    let mounted = true
    const { setStatus, pushNotice } = useRemote.getState()

    void window.api?.remoteStatus().then((status) => {
      if (mounted) setStatus(status)
    })

    const offChanged = window.api?.onRemoteChanged(setStatus)
    const offNotice = window.api?.onRemoteNotice((notice) => {
      pushNotice(notice)
      const remote = useRemote.getState()
      if (notice.type === 'kicked' && remote.selected?.hostId === notice.hostId) {
        remote.select(null)
      }
    })

    return () => {
      mounted = false
      offChanged?.()
      offNotice?.()
    }
  }, [])
}

export default useRemoteLink
