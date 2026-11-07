
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

  // Use a predictable JavaScript string delimiter so compileJS can safely
  // read string values, including scripts containing apostrophes.
  const lib_str = compileJS(inspect(lib, { compact: true, depth: Infinity, quoteStyle: 'double' }))
  js.push(`export const lib = ${ lib_str }`)

  return js.join('\n')
}


const RE_FN = /(script|h_fn|fn):\s*("(?:\\.|[^"\\])*")/g

export function compileJS(js) {
  return js.replace(RE_FN, function(_, key, literal) {
    // Decode the complete util.inspect string literal, including escaped quotes.
    const expr = JSON.parse(literal.replace(/\\x([0-9a-f]{2})/gi, '\\u00$1'))

    return key == 'script' ? `${key}: function() { ${expr.trim()} \n\t\t}`
      : `${key}: ${compileFn(expr, key[0] == 'h')}`
  })
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
