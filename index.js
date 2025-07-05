
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

function camelToSnakeCase(name) {
    let r = "";
    for(const c of name) {
        if("A" <= c && c <= "Z") {
            r += "_" + c.toLowerCase();
        } else {
            r += c;
        }
    }
    return r;
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
    switch(symbol.type) {
        case "dictionary": return generateDictionary(symbol, symbols);
        case "interface": return "//TODO!\n\n";
        case "callback interface": return "//TODO!\n\n";
        case "interface mixin": return ""; // Nothing to do, magic happens in 'includes'
        case "includes": return "//TODO!\n\n";
        case "callback": return "//TODO!\n\n";
        case "enum": return generateEnum(symbol, symbols);
    }
    console.error(`Definitions of type '${symbol.type}' are not implemented`);
    return `// TODO: Definitions of type '${symbol.type}'\n\n`;
}

function generateDictionary(symbol, symbols) {
    let r = "";
    if(symbol.inheritance !== null) {
        // TODO!
        console.error("inheritance for dictionaries is not implemented!");
    }
    const fieldTypeToQuill = field => {
        const t = generateTypeRef(field.idlType, symbols);
        if(field.required || field.idlType.nullable) { return t; }
        return `Option[${t}]`; 
    };
    const fieldNameToQuill = field => {
        return camelToSnakeCase(field.name);
    };
    // declaration
    r += `pub struct ${symbol.name}(`;
    let hadField = false;
    for(const field of symbol.members) {
        if(hadField) { r += `,`; }
        hadField = true;
        r += `\n    ${fieldNameToQuill(field)}: ${fieldTypeToQuill(field)}`;
    }
    r += `\n)\n\n`;
    // default values
    r += `pub fun ${symbol.name}::default(`;
    r += symbol.members
        .filter(field => field.default === null)
        .map(field => `${fieldNameToQuill(field)}: ${fieldTypeToQuill(field)}`)
        .join(", ");
    r += `) -> mut ${symbol.name}\n`;
    r += `    = ${symbol.name}(`;
    r += symbol.members
        .map(field => {
            if(field.default === null) { return fieldNameToQuill(field); }
            const v = generateValue(field.default, field.idlType);
            if(field.required) { return v; }
            if(field.default.type === "null") { return v; }
            return `Option::Some(${v})`;
        })
        .join(", ");
    r += `)\n\n`;
    // from JS
    r += `pub ext fun ${symbol.name}::from_js(value: Any) -> mut ${symbol.name} = "\n`;
    r += `    const r = {};\n`;
    for(const field of symbol.members) {
        const n = fieldNameToQuill(field);
        const v = `#var(value).${field.name}`;
        const qv = field.required
            ? valueToQuillValue(v, field.idlType, symbols)
            : optionalToQuillValue(v, field.idlType, symbols);
        r += `    r.${n} = ${qv};\n`;
    }
    r += `    return r;\n`;
    r += `"\n\n`;
    // as JS
    r += `pub ext fun ${symbol.name}::as_js(self: ${symbol.name}) -> Any = "\n`;
    r += `    const r = {};\n`;
    for(const field of symbol.members) {
        const n = fieldNameToQuill(field);
        const v = `#var(self).${n}`;
        const jv = field.required
            ? valueToJsValue(v, field.idlType, symbols)
            : optionalToJsValue(v, field.idlType, symbols);
        r += `    r.${field.name} = ${jv};\n`;
    }
    r += `    return r;\n`;
    r += `"\n\n`;
    return r;
}

function generateEnum(symbol, symbols) {
    let r = "";
    const variantToQuill = (raw) => raw.slice(0, 1).toUpperCase()
        + raw.slice(1);
    for(const v of symbol.values) {
        const qv = variantToQuill(v.value);
        r += `pub val ${symbol.name}::${qv}: String = "${v.value}";\n`;
    }
    r += "\n";
    return r;
}

function generateValue(value, type) {
    const gen = () => {
        switch(value.type) {
            case "string":
                return `"${value.value}"`;
            case "number":
            case "boolean":
                return value.value;
            case "null":
                return "Option::None";
            case "Infinity":
                return value.negative? "Float::NEG_INF" : "Float::INF";
            case "NaN":
                return "Float::NAN";
            case "sequence":
                return "List::empty()"
            case "dictionary":
                console.error("default values of type 'dictionary' are not implemented");
                return "Option::None";
        }
    };
    switch(type.idlType) {
        case "any":
        case "object":
            return `Any::from(${gen()})`;
    }
    if(type.nullable) {
        if(value.type === "null") { return `Option::None`; }
        return `Option::Some(${gen()})`;
    }
    return gen();
}

function generateTypeRefNamed(type, symbols) {
    if(type.generic) {
        // type.idlType is an array!
        // TODO!
        console.error(`Generics are not yet implemented!`);
        return "Any";
    }
    switch(type.idlType) {
        case "boolean":
            return "Bool";
        case "byte": case "octet":
        case "short": case "unsigned short":
        case "long": case "unsigned long":
        case "long long": case "unsigned long long":
        case "bigint":
            return "Int";
        case "float": case "unrestricted float":
        case "double": case "unrestricted double":
            return "Float";
        case "DOMString": case "ByteString": case "USVString":
            return "String";
        case "ArrayBuffer": case "SharedArrayBuffer":
            // TODO!
            console.error(`Usage of type '${type.idlType}' is not yet implemented`);
            return "Any";
        case "Int8Array": case "Int16Array": case "Int32Array":
        case "Uint8Array": case "Uint16Array": case "Uint32Array":
        case "Uint8ClampedArray":
        case "BigInt64Array": case "BigUint64Array":
        case "Float16Array": case "Float32Array": case "Float64Array":
            // TODO!
            console.error(`Usage of type '${type.idlType}' is not yet implemented`);
            return "Any";
        case "DataView":
            // TODO!
            console.error(`Usage of type '${type.idlType}' is not yet implemented`);
            return "Any";
        case "object":
        case "any":
            return "Any";
        case "undefined":
            return "Unit";
    }
    const symbol = symbols[type.idlType];
    if(symbol === undefined) {
        console.error(`Unable to find type '${type.idlType}'!`);
        return "Any";
    }
    if(symbol.type === "enum") {
        return "String";
    }
    return type.idlType;
}

function generateTypeRef(type, symbols) {
    if(type.nullable) {
        return `Option[${generateTypeRefNamed(type, symbols)}]`;
    }
    if(type.union) {
        // type.idlType is an array!
        // TODO!
        console.error(`Unions are not yet implemented!`);
        return "Any";
    }
    return generateTypeRefNamed(type, symbols);
}

function rawToQuillValue(value, type, symbols) {
    if(type.generic) {
        // type.idlType is an array!
        // TODO!
        console.error(`Generics are not yet implemented!`);
        return value;
    }
    switch(type.idlType) {
        case "boolean":
            return value;
        case "byte": case "octet":
        case "short": case "unsigned short":
        case "long": case "unsigned long":
        case "long long": case "unsigned long long":
            return `BigInt(${value})`;
        case "bigint":
            return value;
        case "float": case "unrestricted float":
        case "double": case "unrestricted double":
            return value;
        case "DOMString": case "ByteString": case "USVString":
            return value;
        case "ArrayBuffer": case "SharedArrayBuffer":
            return value;
        case "Int8Array": case "Int16Array": case "Int32Array":
        case "Uint8Array": case "Uint16Array": case "Uint32Array":
        case "Uint8ClampedArray":
        case "BigInt64Array": case "BigUint64Array":
        case "Float16Array": case "Float32Array": case "Float64Array":
            return value;
        case "DataView":
            return value;
        case "object":
        case "any":
            return value;
        case "undefined":
            return value;
    }
    const symbol = symbols[type.idlType];
    if(symbol === undefined) {
        console.error(`Unable to find type '${type.idlType}'!`);
        return value;
    }
    if(symbol.type === "enum") {
        return value;
    }
    return `#fun(${symbol.name}::from_js)(${value})`;
}

function optionalToQuillValue(value, type, symbols) {
    const t = generateTypeRefNamed(type, symbols);
    return `(${value} === null || ${value} === undefined? #fun(webidl::make_none[${t}])() : #fun(webidl::make_some[${t}])(${rawToQuillValue(value, type, symbols)}))`;
}

function valueToQuillValue(value, type, symbols) {
    if(type.nullable) {
        optionalToQuillValue(value, type, symbols);
    }
    if(type.union) {
        // type.idlType is an array!
        // TODO!
        console.error(`Unions are not yet implemented!`);
        return value;
    }
    return rawToQuillValue(value, type, symbols);
}

function rawToJsValue(value, type, symbols) {
    if(type.generic) {
        // type.idlType is an array!
        // TODO!
        console.error(`Generics are not yet implemented!`);
        return value;
    }
    switch(type.idlType) {
        case "boolean":
            return value;
        case "byte": case "octet":
        case "short": case "unsigned short":
        case "long": case "unsigned long":
        case "long long": case "unsigned long long":
            return `Number(${value})`;
        case "bigint":
            return value;
        case "float": case "unrestricted float":
        case "double": case "unrestricted double":
            return value;
        case "DOMString": case "ByteString": case "USVString":
            return value;
        case "ArrayBuffer": case "SharedArrayBuffer":
            return value;
        case "Int8Array": case "Int16Array": case "Int32Array":
        case "Uint8Array": case "Uint16Array": case "Uint32Array":
        case "Uint8ClampedArray":
        case "BigInt64Array": case "BigUint64Array":
        case "Float16Array": case "Float32Array": case "Float64Array":
            return value;
        case "DataView":
            return value;
        case "object":
        case "any":
            return value;
        case "undefined":
            return value;
    }
    const symbol = symbols[type.idlType];
    if(symbol === undefined) {
        console.error(`Unable to find type '${type.idlType}'!`);
        return value;
    }
    if(symbol.type === "enum") {
        return value;
    }
    return `#fun(${symbol.name}::as_js)(${value})`;
}

function optionalToJsValue(value, type, symbols) {
    const t = generateTypeRefNamed(type, symbols);
    return `(#fun(Option::is_some[${t}])(${value})? ${rawToJsValue(`${value}.value`, type, symbols)} : null)`;
}

function valueToJsValue(value, type, symbols) {
    if(type.nullable) {
        return optionalToJsValue(value, type, symbols);
    }
    if(type.union) {
        // type.idlType is an array!
        // TODO!
        console.error(`Unions are not yet implemented!`);
        return "Any";
    }
    return rawToJsValue(value, type, symbols);
}

main();