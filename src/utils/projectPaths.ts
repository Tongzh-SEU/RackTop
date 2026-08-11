function fallbackName(name: string) {
  return name.trim().replaceAll('/', '-') || 'project'
}

function basename(path: string) {
  return path.trim().replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? ''
}

export function defaultProjectTargetPath(sourcePath: string, name: string) {
  const segments = sourcePath.trim().replaceAll('\\', '/').split('/').filter((segment) => segment && segment !== '~' && segment !== '.')
  const basename = segments.at(-1) ?? fallbackName(name)
  const parent = segments.length > 1 ? segments.at(-2) : undefined
  return parent && parent !== '..' ? `~/${parent}/${basename}` : `~/${basename}`
}

export function isLegacyProjectNameTargetPath(targetPath: string, sourcePath: string, name: string) {
  const targetName = basename(targetPath).toLocaleLowerCase()
  const sourceName = basename(sourcePath).toLocaleLowerCase()
  const projectName = fallbackName(name).toLocaleLowerCase()
  return Boolean(targetName && sourceName && targetName === projectName && sourceName !== projectName)
}
