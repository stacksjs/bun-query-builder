import { CAC } from 'cac'
import { version } from '../package.json'

const cli = new CAC('query-builder')

interface CliOption {
  verbose: boolean
}

cli
  .command('xyz', 'Start the Reverse Proxy Server')
  .option('--verbose', 'Enable verbose logging')
  .example('query-builder xyz --verbose')
  .action(async (options?: CliOption) => {
    console.log('Options:', options)
  })

cli.command('version', 'Show the version of the CLI').action(() => {
  console.log(version)
})

cli.version(version)
cli.help()
cli.parse()
