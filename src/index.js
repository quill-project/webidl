
const fs = require("fs");
const idl = require("webidl2");

function main() {
    const fileNames = process.argv.slice(2);
    if(fileNames.length === 0) {
        console.log("No files specified.");
        return;
    }

    for(const file of fileNames) {
        const content = fs.readFileSync(file, 'utf8');
        const module = file
            .split("/").at(-1)
            .split("\\").at(-1)
            .split(".").at(-2);
        const tree = idl.parse(content);
        const output = generateModule(tree, module);
        const outFile = module + ".quill";
        fs.writeFileSync(outFile, output);
    }
}

function generateModule(tree, module) {
    const symbols = {};
    for(const symbol of tree) {
        if(!symbol.name) { continue; }
        symbols[symbol.name] = symbol;
    }
    let result = `\nmod ${module}\n\n`;
    for(const symbol of tree) {
        result += generateSymbol(symbol, symbols);
    }
    return result;
}

function generateSymbol(symbol, symbols) {
    let r = "";
    switch(symbol.type) {
        case "dictionary": {
            for(const field of symbol.members) {
                console.log(field);
            }
        } break;
        case "interface": {
            r += "//TODO!\n\n";
        } break;
        case "callback interface": {
            r += "//TODO!\n\n";
        } break;
        case "interface mixin": {
            r += "//TODO!\n\n";
        } break;
        case "includes": {
            r += "//TODO!\n\n";
        } break;
        case "callback": {
            r += "//TODO!\n\n";
        } break;
        case "enum": {
            const variantToQuill = (raw) => raw.slice(0, 1).toUpperCase()
                + raw.slice(1);
            for(const v of symbol.values) {
                const qv = variantToQuill(v.value);
                r += `pub val ${symbol.name}::${qv}: String = "${v.value}";\n`;
            }
            r += "\n";
        } break;
        default: {
            console.error(`Definitions of type '${symbol.type}' are not implemented`);
            r += `// TODO: Definitions of type '${symbol.type}'\n\n`;
        }
    }
    return r;
}

// function generateType(name, symbols) {
//     switch(name) {
//         case "boolean":
//             return "Bool";
//         case "byte": case "octet":
//         case "short": case "unsigned short":
//         case "long": case "unsigned long":
//         case "long long": case "unsigned long long":
//         case "bigint":
//             return "Int";
//         case "float": case "unrestricted float":
//         case "double": case "unrestricted double":
//             return "Float";
//         case "DOMString": case "ByteString": case "USVString":
//             return "String";
//         case "ArrayBuffer": case "SharedArrayBuffer":
//             // TODO!
//             console.error(`Usage of type '${name}' is not yet implemented`);
//             return "Unit";
//         case "Int8Array": case "Int16Array": case "Int32Array":
//         case "Uint8Array": case "Uint16Array": case "Uint32Array":
//         case "Uint8ClampedArray":
//         case "BigInt64Array": case "BigUint64Array":
//         case "Float16Array": case "Float32Array": case "Float64Array":
//             // TODO!
//             console.error(`Usage of type '${name}' is not yet implemented`);
//             return "Unit";
//         case "DataView":
//             // TODO!
//             console.error(`Usage of type '${name}' is not yet implemented`);
//             return "Unit";
//         case "object":
//             // TODO!
//             console.error(`Usage of type '${name}' is not yet implemented`);
//             return "Unit";
//         case "any":
//             // TODO!
//             console.error(`Usage of type '${name}' is not yet implemented`);
//             return "Unit";
//         case "undefined":
//             return "Unit";
//     }
// }

main();