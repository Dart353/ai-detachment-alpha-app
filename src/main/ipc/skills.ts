import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import type { SkillInfo } from '../../shared/types'
import { listSkills } from '../skills'
import type { IpcCtx } from './index'

/**
 * The skills list. Read on demand rather than watched: the Skills page asks
 * when it opens and when the user refreshes, and a skill directory changes
 * about as often as a person edits one.
 */
export function registerSkillsIpc(_ctx: IpcCtx): void {
  ipcMain.handle(CH.skillsList, (_event, workspaceRoots?: unknown): SkillInfo[] => {
    const roots = Array.isArray(workspaceRoots)
      ? workspaceRoots.filter((root): root is string => typeof root === 'string')
      : []
    return listSkills(roots)
  })
}
