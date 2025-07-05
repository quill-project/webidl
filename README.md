# webidl
Generator for Quill packages from Web IDL files.

Usage:
```
node index.js <file> <file> <file> <file>
```
The output will be written to the current working directory, with the module and file names matching the ones of the specified files. The Quill modules in each of the files will have the same name, and each of the modules will depend on the Quill package in this repo, `https://github.com/quill-project/webidl`.