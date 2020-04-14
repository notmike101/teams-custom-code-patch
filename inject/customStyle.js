(() => {
  // All stylesheets need to have a Access-Control-Allow-Origin
  // set up for teams.microsoft.com or, alternatively, *
  const stylesheets = [
    'https://mikeorozco.dev/teams-customization/custom-style/custom.php?style=custom.css'
  ]

  // Load remote stylesheets
  async function getStylesheetContent(path) {
    const res = await fetch(path)
    const data = await res.text()
    return data
  }

  // Inject remote stylesheets
  stylesheets.forEach(async (stylesheet) => {
    const content = await getStylesheetContent(stylesheet)
    const newStyleId = stylesheet.substr(stylesheet.lastIndexOf('/') + 1).split('.')[0]

    const existingStyleElement = document.querySelector(`#${newStyleId}`)
    if (existingStyleElement) {
      existingStyleElement.textContent = content
    } else {
      const newStyleElement = document.createElement('style')
      newStyleElement.id = newStyleId
      newStyleElement.textContent = content
      document.head.appendChild(newStyleElement)
    }
  })
})()
