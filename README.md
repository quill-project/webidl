# webidl
Generator for Quill packages from Web IDL files.

Usage:
1. Put any `.idl` or `.webidl` files into the `sources`-directory (any other files will be ignored).
2. Run `index.js`:
```
node index.js <MODULE_NAME>
```
3. The output will be written to `output.quill`. The output Quill symbols of all IDL input files will be inside the module specified by `<MODULE_NAME>`, and the module will be depend on the Quill package inside this repo (`https://github.com/quill-project/webidl`) and the standard library.