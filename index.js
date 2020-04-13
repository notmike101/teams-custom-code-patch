const axios = require('axios')
const ws = require('ws')
const path = require('path')
const fs = require('fs')

class TeamsRunner {
  constructor(port = 31337) {
    this.port = port
    this.debuggerUrl = `http://localhost:${port}`
    this.windowToSocket = null
  }

  async getEndpoints() {
    try {
      const res = await axios.get(`${this.debuggerUrl}/json`)
      return res.data
    } catch(err) {
      return {}
    }
  }

  async injectScript(scriptPath) {
    const payload = {
      id: this.port,
      method: 'Runtime.evaluate',
      params: {
        expression: await getScriptContent(scriptPath),
        objectGroup: 'evalme',
        returnByValue: false,
        userGesture: true
      }
    }

    this.ws.send(JSON.stringify(payload))
    console.log(`Injected script ${scriptPath}`)
  }

  connect() {
    return new Promise(async (resolve, reject) => {
      const endpoints = await this.getEndpoints()
      const target = endpoints.find((endpoint) =>
        endpoint.url.indexOf('/conversations/') !== -1
      )

      const { webSocketDebuggerUrl } = target

      this.ws = new ws(webSocketDebuggerUrl)
      
      this.ws.on('open', () => {
        resolve()
      })
    })
  }

  disconnect() {
    this.ws.close()
  }
}

function getScriptContent(path) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, 'utf8', (err, data) => {
      if (err) reject(err)
      resolve(data)
    })
  })
}

function getScripts() {
  return new Promise((resolve, reject) => {
    const directory = path.join(__dirname, 'inject')
    fs.readdir(directory, (err, files) => {
      if (err) reject(err)
      else resolve(files.map(fileName => ({
        path: `${directory}\\${fileName}`,
        index: fileName.replace('.', ''),
        fileName
      })))
    })
  })
}

async function main() {
  const scriptsToInject = await getScripts()
  const teams = new TeamsRunner()
  await teams.connect()

  const injectors = scriptsToInject.map((script) => teams.injectScript(script.path))
  await Promise.all(injectors)
  
  teams.disconnect()
  return 0
}

main()