import type { PickierConfig } from 'pickier'

const config: PickierConfig = {
  verbose: false,
  ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', 'fixtures/**'],

  lint: {
    extensions: ['ts', 'js', 'tsx', 'jsx'],
    reporter: 'stylish',
    cache: false,
    maxWarnings: -1,
  },

  format: {
    extensions: ['ts', 'js', 'tsx', 'jsx', 'json', 'yaml', 'yml'],
    trimTrailingWhitespace: true,
    maxConsecutiveBlankLines: 1,
    finalNewline: 'one',
    indent: 2,
    quotes: 'single',
    semi: false,
  },

  rules: {
    noDebugger: 'error',
    noConsole: 'off',
  },

  pluginRules: {
    'regexp/no-unused-capturing-group': 'off',
    'ts/no-top-level-await': 'off',
    'max-statements-per-line': 'off',
  },
}

export default config
