# PowerShell-Host

PowerShell-Host is a JavaScript library which hosts a
[PowerShell](https://github.com/PowerShell/PowerShell)
process to allow running commands and getting the results back quickly.
PowerShell Exceptions are intercepted the Exception.Message is emitted to stderr.

This implementation uses Promises to make things easy to use:

-   Output on stderr will be rejected.
-   Output on stdout will be resolved.

## Example:

You can use the in-built ConvertTo-Json applet to make parsing the data easy.

```js
import { PowerShell } from 'powershell-host';

const ps = new PowerShell();

const run = async () => {
    await ps.init();
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
        ps.deinit();
    });
```
