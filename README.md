# Teams Custom Code Patch

By Mike Orozco  
https://mikeorozco.dev

## How To Use

1. Install the LATEST version of NodeJs & NPM
2. Run `npm install`
3. Edit `inject/customStyle.js` to suit your needs
4. Start teams with with `--remote-debugging-port=31337`.
    * Windows: `%LOCALAPPDATA%/Microsoft/Teams/current/Teams.exe --remote-debugging-port=31337`
    * MacOS: **COMING SOON, FEEL FREE TO SUBMIT A PULL REQUEST IF YOU KONW**
5. Run `npm run inject` from terminal

## Scripts Included

- customStyle
     * Allows the user to customize how their Teams client looks.

## Customization

Any file in the `inject/` folder will be loaded into the Teams program.

These files are injected in your operating system's default sorting order

## Notes

* Editing your Teams shortcut to directly target Teams.exe is easier than running from the command line.

* Teams must **ALREADY BE RUNNING** before this script is ran

* Injected files should not be dependent on eachother.  The files are injected separately and should be isolated to ensure that Teams does not run into problems.

* Your scripts can break **AT ANY TIME** because this is not a normal feature for Teams. If something breaks, I'm not responsible.

* Teams has a restrictive CSP (Content-Security-Policy).  This will disallow you from adding in remote CSS & JS.

## Future Features

* Bypass/Modify CSP to allow for loading of external resources
* Watch for teams to allow for running before teams starts