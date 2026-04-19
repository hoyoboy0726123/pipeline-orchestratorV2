'use client'

import { useEffect, useState } from 'react'
import { Settings as SettingsIcon, Save, RefreshCw, AlertCircle, CheckCircle2, Cloud, HardDrive, ArrowLeft, Brain, Package, Plus, Trash2, Loader2, Sparkles, MessageSquare, Bell, Search } from 'lucide-react'
import Link from 'next/link'
import { toast, Toaster } from 'sonner'
import {
  getModelSettings, saveModelSettings, getAvailableModels,
  getSkillPackages, addSkillPackage, removeSkillPackage,
  getNotificationSettings, saveNotificationSettings,
  analyzeRecentLogs,
  listAvailableSkills, scanSkillDependencies,
  scanUnlistedPackages, adoptExistingPackage,
  getNodeStatus,
  type ModelSettings, type AvailableModels, type SkillPackage, type NotificationSettings,
  type LogSuggestion, type AvailableSkill, type SkillDependencies,
  type UnlistedPackage, type NodeStatus,
} from '@/lib/api'
import { cn } from '@/lib/utils'

// ── Claude Code Skills Section ────────────────────────────────────────────────
function InstalledSkillsSection({ onInstallRequest }: { onInstallRequest: (pkg: string) => Promise<void> }) {
  const [skills, setSkills] = useState<AvailableSkill[]>([])
  const [skillsRoot, setSkillsRoot] = useState('')
  const [rootExists, setRootExists] = useState(true)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [depsCache, setDepsCache] = useState<Record<string, SkillDependencies>>({})
  const [scanning, setScanning] = useState<string | null>(null)

  const loadSkills = async () => {
    setLoading(true)
    try {
      const r = await listAvailableSkills()
      setSkills(r.skills || [])
      setSkillsRoot(r.skills_root)
      setRootExists(r.exists)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadSkills() }, [])

  const handleToggleExpand = async (displayName: string) => {
    if (expanded === displayName) {
      setExpanded(null)
      return
    }
    setExpanded(displayName)
    if (!depsCache[displayName]) {
      setScanning(displayName)
      try {
        const deps = await scanSkillDependencies(displayName)
        setDepsCache(prev => ({ ...prev, [displayName]: deps }))
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setScanning(null)
      }
    }
  }

  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-purple-700" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900">Agent Skills</h2>
          <p className="text-sm text-gray-500">已識別的 Skill 清單（來自 <code className="font-mono text-xs bg-gray-100 px-1 rounded">{skillsRoot}</code>）</p>
        </div>
        <button onClick={loadSkills} disabled={loading}
          className="p-2 text-gray-400 hover:text-purple-600 transition-colors disabled:opacity-50" title="重新掃描">
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-gray-400 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin inline-block mr-2" />載入中...
          </div>
        ) : !rootExists ? (
          <div className="p-6 text-center text-gray-400 text-sm">
            <p>Skill 目錄不存在</p>
            <p className="mt-1 text-xs">用 <code className="font-mono bg-gray-100 px-1 py-0.5 rounded">npx skills add anthropics/skills</code> 安裝</p>
          </div>
        ) : skills.length === 0 ? (
          <div className="p-6 text-center text-gray-400 text-sm">目錄存在但沒有任何 Skill</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {skills.map(s => {
              const deps = depsCache[s.display_name]
              const isExpanded = expanded === s.display_name
              const isScanning = scanning === s.display_name
              return (
                <div key={s.display_name} className="transition-colors">
                  <button onClick={() => handleToggleExpand(s.display_name)}
                    className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-mono font-medium text-gray-900">{s.display_name}</span>
                        {s.has_scripts && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">scripts</span>}
                        {s.has_references && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-600">refs</span>}
                        {s.has_assets && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600">assets</span>}
                        {s.has_package_json && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">npm</span>}
                        {s.has_requirements && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600">requirements.txt</span>}
                      </div>
                      {s.description && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{s.description}</p>}
                    </div>
                    <span className="text-xs text-gray-400 shrink-0 mt-0.5">{isExpanded ? '收合 ▲' : '依賴 ▼'}</span>
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-3 bg-gray-50 border-t border-gray-100">
                      {isScanning && <p className="py-3 text-xs text-gray-400"><Loader2 className="w-3 h-3 animate-spin inline mr-1.5" />掃描依賴中…</p>}
                      {!isScanning && deps && (
                        <div className="space-y-3 pt-3 text-xs">
                          {/* Python 依賴 */}
                          <div>
                            <div className="font-medium text-gray-700 mb-1.5">🐍 Python 依賴</div>
                            {deps.python?.requirements_txt && deps.python.requirements_txt.length > 0 && (
                              <div className="mb-2">
                                <span className="text-gray-400">requirements.txt：</span>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {deps.python.requirements_txt.map(r => (
                                    <code key={r} className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-gray-700">{r}</code>
                                  ))}
                                </div>
                              </div>
                            )}
                            {deps.python?.missing && deps.python.missing.length > 0 ? (
                              <div>
                                <span className="text-amber-600">尚未安裝：</span>
                                <div className="mt-1 flex flex-wrap gap-1.5">
                                  {deps.python.missing.map(pkg => (
                                    <div key={pkg} className="flex items-center gap-1 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                                      <code className="text-amber-800">{pkg}</code>
                                      <button onClick={() => onInstallRequest(pkg)}
                                        className="text-purple-600 hover:text-purple-800 text-[11px] font-medium ml-1">安裝</button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <p className="text-gray-400">
                                {deps.python && deps.python.suggested_pip.length === 0
                                  ? '無外部依賴（只用標準庫）'
                                  : '✓ 所有依賴已安裝'}
                              </p>
                            )}
                            {deps.python && deps.python.installed.length > 0 && (
                              <p className="mt-1 text-green-600">已安裝：{deps.python.installed.join(', ')}</p>
                            )}
                          </div>

                          {/* Node 依賴 */}
                          <div>
                            <div className="font-medium text-gray-700 mb-1.5">📦 Node.js 依賴</div>
                            {deps.node?.package_json ? (
                              <div className="bg-red-50 border border-red-200 rounded px-2 py-2">
                                <p className="text-red-700 font-medium mb-1">此 Skill 有 package.json，需要手動執行：</p>
                                <code className="block bg-white px-2 py-1 rounded text-red-800">cd "{deps.path}" && npm install</code>
                                {deps.node.package_json.dependencies && (
                                  <div className="mt-2">
                                    <span className="text-gray-500">dependencies：</span>
                                    <div className="mt-0.5 flex flex-wrap gap-1">
                                      {Object.entries(deps.node.package_json.dependencies).map(([k, v]) => (
                                        <code key={k} className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-gray-700">{k}@{v}</code>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : deps.node?.suggested_npm && deps.node.suggested_npm.length > 0 ? (
                              <div className="space-y-1.5">
                                {deps.node.npm_available === false ? (
                                  <div className="bg-gray-50 border border-gray-200 rounded px-2 py-2 text-gray-600">
                                    <p className="mb-1">SKILL.md 提及需要以下 npm 套件，但系統找不到 <code className="bg-white px-1 rounded">npm</code>，無法判斷是否已安裝：</p>
                                    <div className="flex flex-wrap gap-1">
                                      {deps.node.suggested_npm.map(pkg => (
                                        <code key={pkg} className="px-1.5 py-0.5 bg-white border border-gray-200 rounded">{pkg}</code>
                                      ))}
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    {deps.node.missing_npm && deps.node.missing_npm.length > 0 && (
                                      <div className="bg-amber-50 border border-amber-200 rounded px-2 py-2">
                                        <p className="text-amber-800 mb-1">尚未安裝（請在終端執行 <code className="bg-white px-1 rounded">npm install -g {deps.node.missing_npm.join(' ')}</code>）：</p>
                                        <div className="flex flex-wrap gap-1">
                                          {deps.node.missing_npm.map(pkg => (
                                            <code key={pkg} className="px-1.5 py-0.5 bg-white border border-amber-200 rounded text-amber-900">{pkg}</code>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    {deps.node.installed_npm && deps.node.installed_npm.length > 0 && (
                                      <p className="text-green-600">✓ 已安裝（npm -g）：{deps.node.installed_npm.join(', ')}</p>
                                    )}
                                    {(!deps.node.missing_npm || deps.node.missing_npm.length === 0) &&
                                     (!deps.node.installed_npm || deps.node.installed_npm.length === 0) && (
                                      <p className="text-gray-400">無 Node.js 依賴</p>
                                    )}
                                  </>
                                )}
                              </div>
                            ) : (
                              <p className="text-gray-400">無 Node.js 依賴</p>
                            )}
                          </div>

                          {/* 系統工具 */}
                          {deps.system_tools && deps.system_tools.length > 0 && (
                            <div>
                              <div className="font-medium text-gray-700 mb-1.5">🛠 系統工具（需自行安裝）</div>
                              <div className="flex flex-wrap gap-1.5">
                                {deps.system_tools.map(tool => (
                                  <span key={tool} className="px-2 py-0.5 bg-slate-100 border border-slate-300 rounded text-slate-700 text-[11px]">
                                    {tool}
                                  </span>
                                ))}
                              </div>
                              <p className="mt-1 text-[11px] text-gray-400">這些工具無法透過 pip / npm 安裝，需到官網或用系統套件管理器（winget / brew / apt）取得。</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}


// ── Skill Packages Section ────────────────────────────────────────────────────
function SkillPackagesSection() {
  const [packages, setPackages] = useState<SkillPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [newPkg, setNewPkg] = useState('')
  const [installing, setInstalling] = useState(false)
  const [removingPkg, setRemovingPkg] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [suggestions, setSuggestions] = useState<LogSuggestion[]>([])
  const [analyzedCount, setAnalyzedCount] = useState(0)
  const [logCount, setLogCount] = useState(5)
  const [scanningVenv, setScanningVenv] = useState(false)
  const [unlisted, setUnlisted] = useState<UnlistedPackage[]>([])
  const [adopting, setAdopting] = useState<string | null>(null)

  const loadPkgs = async () => {
    setLoading(true)
    try {
      const pkgs = await getSkillPackages()
      setPackages(pkgs)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadPkgs() }, [])

  const handleAdd = async () => {
    const name = newPkg.trim()
    if (!name) return
    setInstalling(true)
    try {
      const msg = await addSkillPackage(name)
      toast.success(msg)
      setNewPkg('')
      await loadPkgs()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  const handleRemove = async (name: string) => {
    setRemovingPkg(name)
    try {
      const msg = await removeSkillPackage(name)
      toast.success(msg)
      await loadPkgs()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemovingPkg(null)
    }
  }

  const handleAnalyze = async () => {
    setAnalyzing(true)
    try {
      const result = await analyzeRecentLogs(logCount)
      setSuggestions(result.suggestions)
      setAnalyzedCount(result.analyzed)
      if (result.suggestions.length === 0) toast.info(`已分析 ${result.analyzed} 筆 log，未發現缺少的套件`)
      else toast.success(`發現 ${result.suggestions.length} 個建議安裝的套件`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }

  const handleInstallSuggestion = async (pipName: string) => {
    setInstalling(true)
    try {
      const msg = await addSkillPackage(pipName)
      toast.success(msg)
      setSuggestions(prev => prev.filter(s => s.pip_name !== pipName))
      await loadPkgs()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  const handleScanVenv = async () => {
    setScanningVenv(true)
    try {
      const pkgs = await scanUnlistedPackages()
      setUnlisted(pkgs)
      if (pkgs.length === 0) toast.info('venv 已完全同步，無未納管套件')
      else toast.success(`發現 ${pkgs.length} 個已裝但未納管的套件`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setScanningVenv(false)
    }
  }

  const handleAdopt = async (name: string) => {
    setAdopting(name)
    try {
      const msg = await adoptExistingPackage(name)
      toast.success(msg)
      setUnlisted(prev => prev.filter(p => p.name !== name))
      await loadPkgs()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAdopting(null)
    }
  }

  const handleAdoptAll = async () => {
    let ok = 0, fail = 0
    for (const p of unlisted) {
      try {
        await adoptExistingPackage(p.name)
        ok++
      } catch { fail++ }
    }
    toast.success(`已納管 ${ok} 個套件${fail ? `（${fail} 個失敗）` : ''}`)
    setUnlisted([])
    await loadPkgs()
  }

  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
          <Package className="w-5 h-5 text-purple-700" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">AI技能套件</h2>
          <p className="text-sm text-gray-500">管理 AI技能節點可使用的 Python 第三方套件</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* 新增套件 */}
        <div className="p-4 border-b border-gray-100">
          <div className="flex gap-2">
            <input
              value={newPkg}
              onChange={e => setNewPkg(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              placeholder="輸入套件名稱（如 selenium、numpy）"
              disabled={installing}
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
            <button
              onClick={handleAdd}
              disabled={installing || !newPkg.trim()}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-all',
                installing || !newPkg.trim()
                  ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  : 'bg-purple-600 text-white hover:bg-purple-700'
              )}
            >
              {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              安裝
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">套件會安裝到後端的 Python 環境中，AI技能節點執行時可直接 import 使用</p>
        </div>

        {/* 套件清單 */}
        <div className="divide-y divide-gray-100">
          {loading ? (
            <div className="p-6 text-center text-gray-400 text-sm">
              <RefreshCw className="w-4 h-4 animate-spin inline-block mr-2" />
              載入中...
            </div>
          ) : packages.length === 0 ? (
            <div className="p-6 text-center text-gray-400 text-sm">尚無套件</div>
          ) : (
            packages.map(pkg => (
              <div key={pkg.name} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono font-medium text-gray-900">{pkg.name}</span>
                    {pkg.installed ? (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                        {pkg.version || '已安裝'}
                      </span>
                    ) : (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">
                        未安裝
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleRemove(pkg.name)}
                  disabled={removingPkg === pkg.name}
                  className="p-1.5 text-gray-300 hover:text-red-500 transition-colors disabled:opacity-50"
                  title="移除套件"
                >
                  {removingPkg === pkg.name
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Trash2 className="w-4 h-4" />}
                </button>
              </div>
            ))
          )}
        </div>

        {/* Log 分析 */}
        <div className="p-4 border-t border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <Search className="w-4 h-4 text-purple-500" />
            <span className="text-sm font-medium text-gray-700">從執行紀錄分析缺少的套件</span>
          </div>
          <div className="flex items-center gap-2">
            <select value={logCount} onChange={e => setLogCount(Number(e.target.value))}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white text-gray-700 outline-none focus:border-purple-400 cursor-pointer">
              <option value={3}>最近 3 筆</option>
              <option value={5}>最近 5 筆</option>
              <option value={10}>最近 10 筆</option>
            </select>
            <button onClick={handleAnalyze} disabled={analyzing}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-all',
                analyzing ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-purple-600 text-white hover:bg-purple-700'
              )}>
              {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              分析 Log
            </button>
          </div>

          {suggestions.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-gray-500">已分析 {analyzedCount} 筆紀錄，建議安裝以下套件：</p>
              {suggestions.map(s => (
                <div key={s.module} className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-mono font-medium text-gray-800">{s.pip_name}</span>
                    {s.pip_name !== s.module && <span className="text-xs text-gray-400 ml-1.5">（import {s.module}）</span>}
                    <p className="text-xs text-gray-400 truncate">出現在：{s.found_in.join(', ')}</p>
                  </div>
                  <button onClick={() => handleInstallSuggestion(s.pip_name)} disabled={installing}
                    className="px-2.5 py-1 bg-purple-600 text-white rounded-lg text-xs font-medium hover:bg-purple-700 disabled:opacity-50 whitespace-nowrap">
                    安裝
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Venv 同步：納管已手動裝但不在清單的套件 */}
        <div className="p-4 border-t border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw className="w-4 h-4 text-purple-500" />
            <span className="text-sm font-medium text-gray-700">同步 venv：納管終端機手動安裝的套件</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleScanVenv} disabled={scanningVenv}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-all',
                scanningVenv ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-purple-600 text-white hover:bg-purple-700'
              )}>
              {scanningVenv ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              掃描 venv
            </button>
            {unlisted.length > 0 && (
              <button onClick={handleAdoptAll}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700">
                全部納管（{unlisted.length}）
              </button>
            )}
          </div>

          {unlisted.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs text-gray-500">以下是已安裝但未納管的頂層套件（排除後端 requirements.txt）：</p>
              {unlisted.map(p => (
                <div key={p.name} className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  <Package className="w-4 h-4 text-blue-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-mono font-medium text-gray-800">{p.name}</span>
                    {p.version && <span className="text-xs text-gray-400 ml-2">{p.version}</span>}
                  </div>
                  <button onClick={() => handleAdopt(p.name)} disabled={adopting === p.name}
                    className="px-2.5 py-1 bg-purple-600 text-white rounded-lg text-xs font-medium hover:bg-purple-700 disabled:opacity-50 whitespace-nowrap">
                    {adopting === p.name ? <Loader2 className="w-3 h-3 animate-spin" /> : '納管'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部說明 */}
        <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
          <p className="text-xs text-gray-500">
            套件清單儲存在 <code className="font-mono bg-gray-100 px-1 py-0.5 rounded">backend/skill_packages.txt</code>，後端啟動時自動安裝缺少的套件
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Notification Settings Section ────────────────────────────────────────────
function NotificationSection() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [tgToken, setTgToken] = useState('')
  const [tgChatId, setTgChatId] = useState('')
  const [lineToken, setLineToken] = useState('')
  const [original, setOriginal] = useState<NotificationSettings | null>(null)

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const s = await getNotificationSettings()
        setTgToken(s.telegram_bot_token)
        setTgChatId(s.telegram_chat_id)
        setLineToken(s.line_notify_token)
        setOriginal(s)
      } catch (e) { toast.error((e as Error).message) }
      finally { setLoading(false) }
    })()
  }, [])

  const dirty = original && (
    tgToken !== original.telegram_bot_token ||
    tgChatId !== original.telegram_chat_id ||
    lineToken !== original.line_notify_token
  )

  const handleSave = async () => {
    setSaving(true)
    try {
      const saved = await saveNotificationSettings({
        telegram_bot_token: tgToken,
        telegram_chat_id: tgChatId,
        line_notify_token: lineToken,
      })
      setOriginal(saved)
      toast.success('通知設定已儲存')
    } catch (e) { toast.error((e as Error).message) }
    finally { setSaving(false) }
  }

  const inputCls = 'flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent'

  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center">
          <Bell className="w-5 h-5 text-emerald-700" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">通知設定</h2>
          <p className="text-sm text-gray-500">設定 Pipeline 通知管道（人工確認節點、失敗通知）</p>
        </div>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400">
          <RefreshCw className="w-5 h-5 animate-spin inline-block mr-2" />載入中...
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {/* Telegram */}
          <div className="p-5 border-b border-gray-100">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-4 h-4 text-blue-500" />
              <span className="text-sm font-semibold text-gray-800">Telegram Bot</span>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Bot Token</label>
                <input
                  type="password"
                  value={tgToken}
                  onChange={e => setTgToken(e.target.value)}
                  placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                  className={inputCls + ' w-full'}
                />
                <p className="text-xs text-gray-400 mt-1">從 <code className="bg-gray-100 px-1 py-0.5 rounded">@BotFather</code> 取得</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Chat ID</label>
                <input
                  value={tgChatId}
                  onChange={e => setTgChatId(e.target.value)}
                  placeholder="123456789"
                  className={inputCls + ' w-full'}
                />
                <p className="text-xs text-gray-400 mt-1">你的 Telegram 用戶 ID 或群組 ID，可透過 <code className="bg-gray-100 px-1 py-0.5 rounded">@userinfobot</code> 取得</p>
              </div>
            </div>
          </div>

          {/* LINE（預留） */}
          <div className="p-5 border-b border-gray-100 opacity-60">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg leading-none">🟢</span>
              <span className="text-sm font-semibold text-gray-800">LINE Notify</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">即將推出</span>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Access Token</label>
              <input
                value={lineToken}
                onChange={e => setLineToken(e.target.value)}
                placeholder="尚未支援，敬請期待"
                disabled
                className={inputCls + ' w-full bg-gray-50 cursor-not-allowed'}
              />
              <p className="text-xs text-gray-400 mt-1">LINE Notify 整合開發中</p>
            </div>
          </div>

          {/* 儲存按鈕 */}
          <div className="px-5 py-4 bg-gray-50/50 flex items-center justify-between">
            <div className="text-xs text-gray-500">
              {dirty ? '有未儲存的變更' : '尚無變更'}
            </div>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all',
                dirty && !saving
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              )}
            >
              {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              儲存通知設定
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const [current, setCurrent] = useState<ModelSettings | null>(null)
  const [available, setAvailable] = useState<AvailableModels | null>(null)
  const [provider, setProvider] = useState<'groq' | 'ollama' | 'gemini' | 'openrouter'>('groq')
  const [model, setModel] = useState('')
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')
  const [thinking, setThinking] = useState<'auto' | 'on' | 'off'>('off')
  const [numCtx, setNumCtx] = useState<number>(16384)
  const [geminiThinking, setGeminiThinking] = useState<'off' | 'auto' | 'low' | 'medium' | 'high'>('off')
  const [orThinking, setOrThinking] = useState<'off' | 'on'>('off')
  const [loading, setLoading] = useState(true)
  const [availableError, setAvailableError] = useState<string | null>(null)
  const [reloadingModels, setReloadingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [nodeStatus, setNodeStatus] = useState<NodeStatus | null>(null)

  useEffect(() => {
    getNodeStatus().then(setNodeStatus).catch(() => {})
  }, [])

  // 拆開兩個請求：current 是本地 JSON 很快、必要；available 要打 4 個外部 API 可能失敗
  // available 失敗時仍讓使用者看到當前設定與 provider 切換，只把「載入失敗」侷限在模型下拉區
  const loadAvailable = async () => {
    setReloadingModels(true)
    setAvailableError(null)
    try {
      const avail = await getAvailableModels()
      setAvailable(avail)
    } catch (e) {
      setAvailableError((e as Error).message)
    } finally {
      setReloadingModels(false)
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      const cur = await getModelSettings()
      setCurrent(cur)
      setProvider(cur.provider)
      setModel(cur.model)
      setOllamaUrl(cur.ollama_base_url || 'http://localhost:11434')
      setThinking(cur.ollama_thinking || 'off')
      setNumCtx(cur.ollama_num_ctx || 16384)
      setGeminiThinking(cur.gemini_thinking || 'off')
      setOrThinking(cur.openrouter_thinking || 'off')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
    // 背景載入可用模型清單；失敗不影響設定頁其他部分
    loadAvailable()
  }

  useEffect(() => { load() }, [])

  const handleSave = async () => {
    if (!model) {
      toast.error('請選擇模型')
      return
    }
    setSaving(true)
    try {
      const saved = await saveModelSettings({
        provider, model,
        ollama_base_url: ollamaUrl, ollama_thinking: thinking, ollama_num_ctx: numCtx,
        gemini_thinking: geminiThinking, openrouter_thinking: orThinking,
      })
      setCurrent(saved)
      toast.success(`已儲存：${saved.provider} / ${saved.model}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const options = provider === 'groq'
    ? (available?.groq ?? [])
    : provider === 'gemini'
    ? (available?.gemini ?? [])
    : provider === 'openrouter'
    ? (available?.openrouter ?? [])
    : (available?.ollama ?? [])
  const providerError = provider === 'groq' ? available?.groq_error
    : provider === 'gemini' ? available?.gemini_error
    : provider === 'openrouter' ? available?.openrouter_error
    : available?.ollama_error
  const dirty = current && (
    provider !== current.provider ||
    model !== current.model ||
    ollamaUrl !== current.ollama_base_url ||
    thinking !== current.ollama_thinking ||
    numCtx !== current.ollama_num_ctx ||
    geminiThinking !== (current.gemini_thinking || 'off') ||
    orThinking !== (current.openrouter_thinking || 'off')
  )

  return (
    <div className="flex-1 overflow-auto bg-gray-50">
      <Toaster position="top-right" richColors />
      <div className="max-w-3xl mx-auto p-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/pipeline"
            className="p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-white transition-colors"
            title="回到 Pipeline"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center">
            <SettingsIcon className="w-5 h-5 text-brand-700" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">設定</h1>
            <p className="text-sm text-gray-500">調整 Pipeline 執行與驗證時使用的 LLM 模型</p>
          </div>
        </div>

        {/* Node.js 環境警示（優先顯示，很多 skill 靠 npm 套件） */}
        {nodeStatus && !nodeStatus.node_installed && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-red-800 mb-1">系統找不到 Node.js</div>
                <p className="text-xs text-red-700 leading-relaxed mb-2">
                  部分 Agent Skill（例如 <code className="bg-white px-1 rounded">pptx</code>）需要 <code className="bg-white px-1 rounded">npm</code> 套件（<code className="bg-white px-1 rounded">pptxgenjs</code> 等）才能完整運作。沒有 Node.js 會導致這些 Skill 執行失敗。
                </p>
                <p className="text-xs text-red-700">
                  安裝方式：<span className="break-all">{nodeStatus.install_hint}</span>
                </p>
              </div>
            </div>
          </div>
        )}
        {nodeStatus && nodeStatus.node_installed && !nodeStatus.npm_installed && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-amber-800 mb-1">Node.js 已安裝但找不到 npm</div>
                <p className="text-xs text-amber-700">
                  Node.js ({nodeStatus.node_version}) 已偵測到，但無法找到 <code className="bg-white px-1 rounded">npm</code> 指令。請重新安裝 Node.js LTS 版本或確認 npm 已加入 PATH。
                </p>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400">
            <RefreshCw className="w-5 h-5 animate-spin inline-block mr-2" />
            載入中...
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {/* Current */}
            <div className="px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-brand-50 to-purple-50">
              <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-1">目前使用的模型</div>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-xs font-semibold uppercase bg-white border border-gray-200 text-gray-700">
                  {current?.provider}
                </span>
                <span className="font-mono text-sm font-medium text-gray-900">
                  {current?.model}
                </span>
              </div>
            </div>

            {/* Provider 選擇 */}
            <div className="p-6 border-b border-gray-100">
              <label className="block text-sm font-medium text-gray-700 mb-3">提供者</label>
              <div className="grid grid-cols-2 gap-3">
                {([
                  { v: 'groq' as const, icon: Cloud, name: 'Groq Cloud', desc: '雲端 API，速度快', fallbackModel: '' },
                  { v: 'gemini' as const, icon: Sparkles, name: 'Google Gemini', desc: '支援思考模式', fallbackModel: 'gemma-4-31b-it' },
                  { v: 'openrouter' as const, icon: Cloud, name: 'OpenRouter', desc: '免費模型，多供應商', fallbackModel: '' },
                  { v: 'ollama' as const, icon: HardDrive, name: 'Ollama 本地', desc: '離線運行，無配額', fallbackModel: '' },
                ]).map(p => (
                  <button
                    key={p.v}
                    onClick={() => {
                      setProvider(p.v)
                      const list = p.v === 'groq' ? available?.groq
                        : p.v === 'gemini' ? available?.gemini
                        : p.v === 'openrouter' ? available?.openrouter
                        : available?.ollama
                      setModel(list?.[0]?.id ?? p.fallbackModel)
                    }}
                    className={cn(
                      'flex items-center gap-3 p-4 rounded-lg border-2 transition-all text-left',
                      provider === p.v
                        ? 'border-brand-600 bg-brand-50'
                        : 'border-gray-200 hover:border-gray-300'
                    )}
                  >
                    <p.icon className={cn('w-5 h-5 shrink-0', provider === p.v ? 'text-brand-700' : 'text-gray-400')} />
                    <div className="min-w-0">
                      <div className="font-medium text-sm text-gray-900">{p.name}</div>
                      <div className="text-xs text-gray-500">{p.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Ollama URL */}
            {provider === 'ollama' && (
              <div className="p-6 border-b border-gray-100">
                <label className="block text-sm font-medium text-gray-700 mb-2">Ollama Base URL</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                    placeholder="http://localhost:11434"
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                  />
                  <button
                    onClick={load}
                    className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-4 h-4" />
                    重新讀取
                  </button>
                </div>
              </div>
            )}

            {/* Provider 錯誤提示 */}
            {providerError && (
              <div className="mx-6 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{providerError}</span>
              </div>
            )}

            {/* 思考模式 — Ollama */}
            {provider === 'ollama' && (
              <div className="p-6 border-b border-gray-100">
                <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
                  <Brain className="w-4 h-4" />
                  思考模式
                </label>
                <p className="text-xs text-gray-500 mb-3">控制 qwen3 等支援思考的模型是否輸出推理過程（關閉可大幅加快速度）</p>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { v: 'auto', label: '預設', desc: '依模型設定' },
                    { v: 'off',  label: '關閉思考', desc: '最快，省時間' },
                    { v: 'on',   label: '開啟思考', desc: '更準確，較慢' },
                  ] as const).map(opt => (
                    <button
                      key={opt.v}
                      onClick={() => setThinking(opt.v)}
                      className={cn(
                        'p-3 rounded-lg border-2 transition-all text-left',
                        thinking === opt.v
                          ? 'border-brand-600 bg-brand-50'
                          : 'border-gray-200 hover:border-gray-300'
                      )}
                    >
                      <div className="text-sm font-medium text-gray-900">{opt.label}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 思考模式 — Gemini */}
            {provider === 'gemini' && (
              <div className="p-6 border-b border-gray-100">
                <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
                  <Brain className="w-4 h-4" />
                  思考模式
                </label>
                <p className="text-xs text-gray-500 mb-3">
                  Gemini 2.5+ / 3.x 支援思考模式，會在回答前先進行推理。選擇不支援的模型時自動忽略此設定。
                </p>
                <div className="grid grid-cols-5 gap-2">
                  {([
                    { v: 'off',    label: '關閉',   desc: '不思考' },
                    { v: 'auto',   label: '自動',   desc: '模型決定' },
                    { v: 'low',    label: '低',     desc: '快速' },
                    { v: 'medium', label: '中等',   desc: '均衡' },
                    { v: 'high',   label: '高',     desc: '最深入' },
                  ] as const).map(opt => (
                    <button
                      key={opt.v}
                      onClick={() => setGeminiThinking(opt.v)}
                      className={cn(
                        'p-3 rounded-lg border-2 transition-all text-left',
                        geminiThinking === opt.v
                          ? 'border-brand-600 bg-brand-50'
                          : 'border-gray-200 hover:border-gray-300'
                      )}
                    >
                      <div className="text-sm font-medium text-gray-900">{opt.label}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 思考模式 — OpenRouter */}
            {provider === 'openrouter' && (
              <div className="p-6 border-b border-gray-100">
                <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
                  <Brain className="w-4 h-4" />
                  思考模式
                </label>
                <p className="text-xs text-gray-500 mb-3">
                  DeepSeek R1 等推理模型會在回答前輸出思考過程。選擇不支援思考的模型時自動以普通模式運行。
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { v: 'off', label: '關閉思考', desc: '普通輸出' },
                    { v: 'on',  label: '開啟思考', desc: '推理模型會先思考' },
                  ] as const).map(opt => (
                    <button
                      key={opt.v}
                      onClick={() => setOrThinking(opt.v)}
                      className={cn(
                        'p-3 rounded-lg border-2 transition-all text-left',
                        orThinking === opt.v
                          ? 'border-brand-600 bg-brand-50'
                          : 'border-gray-200 hover:border-gray-300'
                      )}
                    >
                      <div className="text-sm font-medium text-gray-900">{opt.label}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Context window（僅 Ollama）*/}
            {provider === 'ollama' && (
              <div className="p-6 border-b border-gray-100">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Context 長度 (num_ctx)
                </label>
                <p className="text-xs text-gray-500 mb-3">
                  模型一次能處理的 token 數。越大越不容易截斷，但吃更多 VRAM 且變慢。預設 16384 通常足夠。
                </p>
                <div className="grid grid-cols-4 gap-2 mb-3">
                  {[8192, 16384, 32768, 65536].map((v) => (
                    <button
                      key={v}
                      onClick={() => setNumCtx(v)}
                      className={cn(
                        'p-2 rounded-lg border-2 transition-all text-sm',
                        numCtx === v
                          ? 'border-brand-600 bg-brand-50 text-brand-700 font-medium'
                          : 'border-gray-200 hover:border-gray-300 text-gray-700'
                      )}
                    >
                      {v >= 1024 ? `${v / 1024}K` : v}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  value={numCtx}
                  onChange={(e) => setNumCtx(Math.max(2048, Math.min(262144, parseInt(e.target.value) || 16384)))}
                  min={2048}
                  max={262144}
                  step={2048}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
              </div>
            )}

            {/* 模型選擇 */}
            <div className="p-6 border-b border-gray-100">
              <label className="block text-sm font-medium text-gray-700 mb-3">
                模型
                {provider === 'ollama' && <span className="text-xs text-gray-400 ml-2">（讀取自 ollama list）</span>}
                {provider === 'groq' && <span className="text-xs text-gray-400 ml-2">（從 Groq API 動態取得）</span>}
                {provider === 'gemini' && <span className="text-xs text-gray-400 ml-2">（從 Google API 動態取得）</span>}
                {provider === 'openrouter' && <span className="text-xs text-gray-400 ml-2">（僅列出免費模型）</span>}
                {reloadingModels && <span className="text-xs text-indigo-500 ml-2"><Loader2 className="w-3 h-3 animate-spin inline mr-1" />載入中…</span>}
              </label>
              {availableError ? (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <div className="font-medium mb-1">模型清單載入失敗</div>
                  <div className="text-xs mb-2 break-all">{availableError}</div>
                  <button onClick={loadAvailable} disabled={reloadingModels}
                    className="text-xs px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                    {reloadingModels ? '重試中…' : '重試'}
                  </button>
                </div>
              ) : options.length === 0 ? (
                <div className="p-4 bg-gray-50 rounded-lg text-sm text-gray-500 text-center">
                  {provider === 'ollama'
                    ? (available?.ollama_error ? `尚未發現 Ollama 模型：${available.ollama_error}` : '尚未發現任何 Ollama 本地模型')
                    : reloadingModels ? '載入中…' : '無可用模型'}
                </div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {options.map((opt) => (
                    <label
                      key={opt.id}
                      className={cn(
                        'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all',
                        model === opt.id
                          ? 'border-brand-600 bg-brand-50'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      )}
                    >
                      <input
                        type="radio"
                        name="model"
                        value={opt.id}
                        checked={model === opt.id}
                        onChange={() => setModel(opt.id)}
                        className="accent-brand-600"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">{opt.label}</div>
                        <div className="text-xs text-gray-500 font-mono truncate">{opt.id}</div>
                      </div>
                      {model === opt.id && current?.model === opt.id && current?.provider === provider && (
                        <CheckCircle2 className="w-4 h-4 text-brand-600 shrink-0" />
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* 儲存 */}
            <div className="px-6 py-4 bg-gray-50/50 flex items-center justify-between">
              <div className="text-xs text-gray-500">
                {dirty ? '有未儲存的變更' : '尚無變更'}
              </div>
              <button
                onClick={handleSave}
                disabled={saving || !dirty || !model}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all',
                  dirty && model && !saving
                    ? 'bg-brand-600 text-white hover:bg-brand-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                )}
              >
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                儲存設定
              </button>
            </div>
          </div>
        )}

        {/* Installed Skills (Claude Code skills from ~/.agents/skills/) */}
        <InstalledSkillsSection onInstallRequest={async (pkg) => {
          try {
            const msg = await addSkillPackage(pkg)
            toast.success(msg)
          } catch (e) {
            toast.error((e as Error).message)
          }
        }} />

        {/* Skill Packages */}
        <SkillPackagesSection />

        {/* Notifications */}
        <NotificationSection />

        {/* 提示 */}
        <div className="mt-4 text-xs text-gray-500 space-y-1">
          <p>• 設定會立即生效（新 pipeline 執行會使用新模型）</p>
          <p>• 設定儲存在 <code className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">~/ai_output/pipeline_settings.json</code></p>
          <p>• 模型列表從各 API 動態取得，OpenRouter 僅顯示免費模型</p>
          <p>• OpenRouter API Key 請在 <code className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">backend/.env</code> 設定 OPENROUTER_API_KEY（免費模型不需要 key 也可列出清單）</p>
        </div>
      </div>
    </div>
  )
}
