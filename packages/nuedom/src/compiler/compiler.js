
/* Compiles template string to JavaScript object (AST) */
import { inspect } from 'node:util'
import { parseNue } from './document.js'


export function compileNue(template) {
  const doc = typeof template == 'string' ? parseNue(template) : template
  return compileDoc(doc)
}

function compileDoc(doc) {
  const { script, lib } = doc
  const js = []

  if (script) js.push(script)

  const lib_str = compileJS(lib)
  js.push(`export const lib = ${ lib_str }`)

  return js.join('\n')
}



export function compileJS(ast) {
  const replacements = []
  let markerId = 0

  function prepare(value) {
    if (Array.isArray(value)) return value.map(prepare)
    if (!value || typeof value != 'object') return value

    return Object.fromEntries(Object.entries(value).map(([key, val]) => {
      if (typeof val == 'string' && ['script', 'fn', 'h_fn'].includes(key)) {
        let marker
        do {
          marker = `__NUE_COMPILED_${markerId++}__`
        } while (containsString(ast, marker))

        const code = key == 'script'
          ? `function() { ${val.trim()} \n\t\t}`
          : compileFn(val, key == 'h_fn')

        replacements.push([inspect(marker), code])
        return [key, marker]
      }

      return [key, prepare(val)]
    }))
  }

  let js = inspect(prepare(ast), { compact: true, depth: Infinity })
  replacements.forEach(([marker, code]) => {
    js = js.replace(marker, () => code)
  })
  return js
}

function containsString(value, str) {
  if (typeof value == 'string') return value.includes(str)
  if (Array.isArray(value)) return value.some(item => containsString(item, str))
  if (value && typeof value == 'object') {
    return Object.entries(value).some(([key, val]) =>
      key.includes(str) || containsString(val, str)
    )
  }
  return false
}

// compiler.test.js: _.foo + 1 --> _=>(_.foo + 1)
export function compileFn(str, is_event) {
  str = str.trim()

  const word = str.startsWith('_.') ? str.slice(2) : str

  const is_simple = !/\W/.test(word)

  if (is_event) {
    return '(_,$e)=>' + (is_simple ? `${str}($e)`
      : str.includes(';') ? `{${str}}`
      : str
    )
  }
  return '_=>' + (is_simple ? str : `(${str})`)
}
