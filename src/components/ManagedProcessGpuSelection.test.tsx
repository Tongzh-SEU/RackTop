// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ManagedProcessView } from './ManagedProcessView'
import type { Server, Snapshot } from '../types/models'
vi.mock('../services/api', () => ({ api: { isDesktop: true } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const server = {id:'s', name:'test', status:'online'} as Server
const snapshot = {serverId:'s', processes:[], cpuProcesses:[], gpus:[{uuid:'g0',index:0,memoryTotalMb:8192,memoryUsedMb:0}],system:{memoryAvailableBytes:1024,memoryTotalBytes:2048}} as unknown as Snapshot
async function setup(){
 localStorage.clear()
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node)
 await act(async()=>root.render(<ManagedProcessView servers={[server]} snapshots={{s:snapshot}} projects={[]} onNotice={()=>{}} onOpenTerminal={()=>{}} onRefreshServer={async()=>{}}/>))
 const click=async(text:string)=>{const b=[...node.querySelectorAll('button')].find(b=>b.textContent===text);expect(b).toBeDefined();await act(async()=>b!.click())}
 await click('启动任务')
 const gpu=()=>node.querySelector<HTMLInputElement>('.managed-gpu-list input')!
 return {node,root,click,gpu}
}
it('switching from automatic to manual clears the automatic GPU choice',async()=>{
 const s=await setup()
 try{expect(s.gpu().checked).toBe(true);await s.click('指定 GPU');expect(s.gpu().checked).toBe(false)}finally{await act(async()=>s.root.unmount());s.node.remove()}
})
it('clicking the already active manual mode preserves a user GPU choice',async()=>{
 const s=await setup()
 try{await s.click('指定 GPU');if(!s.gpu().checked)await act(async()=>s.gpu().click());expect(s.gpu().checked).toBe(true);await s.click('指定 GPU');expect(s.gpu().checked).toBe(true)}finally{await act(async()=>s.root.unmount());s.node.remove()}
})

it('returning to automatic restores recommendation, then manual starts empty again', async () => {
 const s = await setup()
 try {
  await s.click('指定 GPU')
  await act(async () => s.gpu().click())
  await s.click('自动推荐')
  expect(s.gpu().checked).toBe(true)
  expect(s.gpu().disabled).toBe(true)
  await s.click('指定 GPU')
  expect(s.gpu().checked).toBe(false)
  expect(s.gpu().disabled).toBe(false)
 } finally { await act(async () => s.root.unmount()); s.node.remove() }
})
