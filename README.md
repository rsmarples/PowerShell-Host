# PowerShell-Host

PowerShell-Host is a JavaScript library which hosts a
[PowerShell](https://github.com/PowerShell/PowerShell)
process to allow running commands and getting the results back quickly.
PowerShell Exceptions are intercepted and the Message property is
emitted to stderr.

This implementation uses Promises to make things easy to use:

- Output on stderr will be rejected.
- Output on stdout will be resolved.

## Installation

`npm install powershell-host`

## Example

You can use the in-built ConvertTo-Json applet to make parsing the data easy.

```js
import { PowerShell } from 'powershell-host';

const ps = new PowerShell();

const run = async () => {
    // Open a new PowerShell without any profile which might impede us
    // We could use `shell: 'pwsh'` in the options to open a newer PowerShell if installed
    await ps.open({ args: ['-NoProfile'] });

    // Log any errors that might occur after opening
    // such as invalid arguments in the open command above
    ps.on('error', (err) => {
        console.log(`ERROR: ${err}`);
    });

    // Log if shell exits for any reason
    ps.on('exit', (code, signal) => {
        // Will not log graceful exit we removed all listeners on close
        console.log(`shell exited code:${code} signal: ${signal}`);
    });

    const json = await ps.exec('Get-PsDrive | Select Name, Root | ConvertTo-Json');
    const obj = JSON.parse(json);
    // Newer versions of PowerShell can use ConvertTo-Json -ToArray to avoid forcing an array here
    const result = Array.isArray(obj) ? obj : [obj];
    result.forEach((drive) => console.log(drive.Name));
};

run()
    .catch((err) => {
        console.error(`ERROR: ${err.message}`);
    })
    .finally(() => {
        ps.close();
        ps.removeAllListeners();
    });
```
