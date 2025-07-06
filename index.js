
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

const toSnakeCase = name => [...name]
    .map((c, i) => {
        const isUpper = t => t === t.toUpperCase();
        if(!isUpper(c)) { return c; }
        const isFirstUpper = i > 0 && !isUpper(name[i - 1]);
        const isInAcronym = i > 0 && isUpper(name[i - 1]);
        const endOfAcronym = i + 1 < name.length && !isUpper(name[i + 1]);
        const insertU = isFirstUpper || (isInAcronym && endOfAcronym);
        return (insertU? "_" : "") + c.toLowerCase();
    })
    .join("");

function generateModule(tree, module) {
    const symbols = {};
    for(const symbol of tree) {
        if(!symbol.name) { continue; }
        symbols[symbol.name] = symbol;
    }
    let result = `\nmod ${module}\n\nuse js::*\n\n`;
    for(const symbol of tree) {
        result += generateSymbol(symbol, symbols, tree);
    }
    return result;
}

function generateSymbol(symbol, symbols, tree) {
    switch(symbol.type) {
        case "dictionary": return generateDictionary(symbol, symbols, tree);
        case "interface": return generateInterface(symbol, symbols, tree)
            + generateInterfaceConstants(symbol, symbols, tree);
        case "interface mixin": return ""; // Nothing to do, magic happens in 'interface'
        case "includes": // Nothing to do, magic happens in 'interface'
        case "callback": return ""; // nothing to do, magic happens in type ref generator function
        case "callback interface": return generateInterfaceConstants(symbol, symbols, tree);
        case "typedef": return ""; // nothing to do, magic happens in type ref generator function
        case "enum": return generateEnum(symbol, symbols);
    }
    console.warn(`Definitions of type '${symbol.type}' are not implemented`);
    return `// TODO: Definitions of type '${symbol.type}'\n\n`;
}

function collectSymbolMembers(symbol, symbols, tree) {
    const seen = new Set();
    const collected = [];
    let searched = symbol;
    for(;;) {
        if(seen.has(searched.name)) { break; }
        seen.add(searched.name);
        for(const member of searched.members) {
            if(member.type === "constructor" && searched !== symbol) {
                continue;
            }
            collected.push(member);
        }
        if(!searched.inheritance) { break; }
        searched = symbols[searched.inheritance];
        if(searched === undefined) {
            console.warn(`Could not find dictionary '${searched.inheritance}'!`);
            break;
        }
    }
    for(const def of tree) {
        if(def.type !== "includes" || def.target !== symbol.name) { continue; }
        const included = symbols[def.includes];
        if(seen.has(included.name)) { continue; }
        seen.add(included.name);
        collected.push(...included.members);
    }
    return collected;
}

function generateInterface(symbol, symbols, tree) {
    let r = "";
    const members = collectSymbolMembers(symbol, symbols, tree);
    r += `struct ${symbol.name}()\n\n`;
    // generation of inheritance casts
    if(symbol.inheritance !== null) {
        let base = symbol.inheritance;
        while(base !== null) {
            const baseSC = toSnakeCase(base);
            r += `/// Converts a reference to '${symbol.name}' to a reference to '${base}'.\n`;
            r += `/// This does not involve manipulating the object or reference.\n`;
            r += `pub ext fun ${symbol.name}::as_${baseSC}(self: ${symbol.name}) -> ${base} = "return #var(self);"\n\n`;
            r += `/// Converts a mutable reference to '${symbol.name}' to a mutable reference to '${base}'.\n`;
            r += `/// This does not involve manipulating the object or reference.\n`;
            r += `pub ext fun ${symbol.name}::as_m${baseSC}(self: mut ${symbol.name}) -> mut ${base} = "return #var(self);"\n\n`;
            r += `/// Attempts to convert a reference to '${base}' to a reference to '${symbol.name}'.\n`;
            r += `/// The conversion may fail and panic if 'base' is not a reference to '${symbol.name}' or if the given instance is user-implemented.\n`;
            r += `/// This does not involve manipulating the object or reference.\n`;
            r += `pub ext fun ${symbol.name}::from_${baseSC}(base: ${base}) -> ${symbol.name} = "\n`;
            r += `    if(#var(base) instanceof ${symbol.name}) { return #var(base); }\n`
            r += `    #fun(panic[Unit])(\\"Failed to downcast '${base}' to '${symbol.name}'!\\");\n`
            r += `"\n\n`
            r += `/// Attempts to convert a mutable reference to '${base}' to a mutable reference to '${symbol.name}'.\n`;
            r += `/// The conversion may fail and panic if 'base' is not a reference to '${symbol.name}' or if the given instance is user-implemented.\n`;
            r += `/// This does not involve manipulating the object or reference.\n`;
            r += `pub ext fun ${symbol.name}::from_m${baseSC}(base: mut ${base}) -> mut ${symbol.name} = "\n`;
            r += `    if(#var(base) instanceof ${symbol.name}) { return #var(base); }\n`
            r += `    #fun(panic[Unit])(\\"Failed to downcast '${base}' to '${symbol.name}'!\\");\n`
            r += `"\n\n`;
            base = symbols[base].inheritance;
        }
    }
    const generateArgumentDecl = arg => {
        const name = toSnakeCase(arg.name);
        const type = generateTypeRef(arg.idlType, symbols, true);
        if(!arg.variadic) { return `${name}: ${type}`; }
        return `...${name}: List[${type}]`;
    };
    const generateArgumentToJs = arg => {
        const qv = `#var(${toSnakeCase(arg.name)})`;
        if(!arg.variadic) { return valueToJsValue(qv, arg.idlType, symbols); }
        return `(${qv}).map(v => ${valueToJsValue("v", arg.idlType, symbols)})`;
    };
    // TODO! method for implementing, returns mut ref (duck typing :/)
    // generation of constructors
    const constructors = members
        .filter(member => member.type === "constructor");
    for(const constructor of constructors) {
        const name = constructor.arguments.length === 0? "new"
            : `from_` + constructor.arguments
                .map(arg => generateOverloadTypeRef(arg.idlType, symbols, true))
                .join("_");
        r += `pub ext fun ${symbol.name}::${name}(`;
        r += constructor.arguments.map(generateArgumentDecl).join(", ");
        r += `) -> mut ${symbol.name}\n`;
        r += `    = "new ${symbol.name}(`;
        r += constructor.arguments.map(generateArgumentToJs).join(", ");
        r += `);"\n\n`;
    }
    // generation of attributes
    const attributes = members
        .filter(member => member.type === "attribute");
    for(const attribute of attributes) {
        let selfArgRead = `self: ${symbol.name}`;
        let selfArgWrite = `self: mut ${symbol.name}, `;
        let jsAccessed = `#var(self)`;
        if(attribute.special === "static") {
            selfArgRead = "";
            selfArgWrite = "";
            jsAccessed = symbol.name;
        }
        if(!["", "static", "stringifier"].includes(attribute.special)) {
            // TODO!
            console.warn(`Unhandled special attribute type '${attribute.special}'!`);
        }
        const nameSC = toSnakeCase(attribute.name);
        const valueT = generateTypeRef(attribute.idlType, symbols, true);
        const value = `${jsAccessed}.${attribute.name}`;
        r += `pub ext fun ${symbol.name}::${nameSC}(${selfArgRead}) -> ${valueT}\n`;
        r += `    = "return ${valueToQuillValue(value, attribute.idlType, symbols)};"\n\n`;
        if(!attribute.readonly) {
            r += `pub ext fun ${symbol.name}::set_${nameSC}(${selfArgWrite}value: ${valueT})\n`;
            r += `    = "${value} = ${valueToJsValue(`#var(value)`, attribute.idlType, symbols)};"\n\n`;
        }
    }
    // generation of operations
    const operations = members
        .filter(member => member.type === "operation")
    for(const operation of operations) {
        const getMangledName = quillName => {
            const overloads = operations.filter(
                o => o.name === operation.name 
                    && o.special === operation.special
            );
            if(overloads.length === 1) { return quillName; }
            if(operation.arguments.length === 0) { return quillName; }
            return quillName + "_" + operation.arguments
                .map(arg => generateOverloadTypeRef(arg.idlType, symbols, true))
                .join("_");
        };
        const generateAsMethod = (quillName, jsName, retT, retV) => {
            r += `pub ext fun ${symbol.name}::${quillName}(__self: mut ${symbol.name}`;
            r += operation.arguments.map(a => `, ${generateArgumentDecl(a)}`).join("");
            r += `) -> ${retT} = "\n`;
            r += `    const r = #var(__self).${jsName}(`;
            r += operation.arguments.map(generateArgumentToJs).join(", ");
            r += `);\n`;
            r += `    return ${retV};\n`
            r += `"\n\n`;
        };
        const generateAsStatic = (quillName, jsName, retT, retV) => {
            r += `pub ext fun ${symbol.name}::${quillName}(`;
            r += operation.arguments.map(generateArgumentDecl).join(", ");
            r += `) -> ${retT} = "\n`;
            r += `    const r = ${symbol.name}.${jsName}(`;
            r += operation.arguments.map(generateArgumentToJs).join(", ");
            r += `);\n`;
            r += `    return ${retV};\n`
            r += `"\n\n`;
        };
        const generateAsGetter = (retT, retV) => {
            r += `pub ext fun ${symbol.name}::${getMangledName("get")}(__self: ${symbol.name}`;
            r += operation.arguments.map(a => `, ${generateArgumentDecl(a)}`).join("");
            r += `) -> ${retT} = "\n`;
            r += `    const r = ${symbol.name}[${generateArgumentToJs(operation.arguments[0])}];\n`;
            r += `    return ${retV};\n`
            r += `"\n\n`;
        };
        const generateAsSetter = () => {
            const key = generateArgumentToJs(operation.arguments[0]);
            const value = generateArgumentToJs(operation.arguments[1]);
            r += `pub ext fun ${symbol.name}::${getMangledName("set")}(__self: mut ${symbol.name}`;
            r += operation.arguments.map(a => `, ${generateArgumentDecl(a)}`).join("");
            r += `) = "\n`;
            r += `    ${symbol.name}[${key}] = ${value};\n`;
            r += `"\n\n`;
        };
        const generateAsDeleter = () => {
            r += `pub ext fun ${symbol.name}::${getMangledName("remove")}(__self: mut ${symbol.name}`;
            r += operation.arguments.map(a => `, ${generateArgumentDecl(a)}`).join("");
            r += `) = "\n`;
            r += `    delete ${symbol.name}[${generateArgumentToJs(operation.arguments[0])}];\n`;
            r += `"\n\n`;
        };
        switch(operation.special) {
            case "": {
                const quillName = getMangledName(toSnakeCase(operation.name));
                const retT = operation.idlType === undefined? "Unit"
                    : generateTypeRef(operation.idlType, symbols, true);
                const retV = operation.idlType === undefined? "undefined"
                    : valueToQuillValue("r", operation.idlType, symbols);
                generateAsMethod(quillName, operation.name, retT, retV);
            } break;
            case "stringifier": {
                const jsName = operation.name.length === 0? "toString"
                    : operation.name;
                const quillName = operation.name.length === 0? "as_string"
                    : getMangledName(toSnakeCase(operation.name));
                const retT = operation.idlType === undefined? "String"
                    : generateTypeRef(operation.idlType, symbols, true);
                const retV = operation.idlType === undefined? "r"
                    : valueToQuillValue("r", operation.idlType, symbols);
                generateAsMethod(quillName, jsName, retT, retV);
            } break;
            case "static": {
                const quillName = getMangledName(toSnakeCase(operation.name));
                const retT = operation.idlType === undefined? "Unit"
                    : generateTypeRef(operation.idlType, symbols, true);
                const retV = operation.idlType === undefined? "undefined"
                    : valueToQuillValue("r", operation.idlType, symbols);
                generateAsStatic(quillName, operation.name, retT, retV);
            } break;
            case "getter": {
                const retT = generateTypeRef(operation.idlType, symbols, true);
                const retV = valueToQuillValue("r", operation.idlType, symbols);
                if(operation.name.length > 0) {
                    const quillName = getMangledName(toSnakeCase(operation.name));
                    generateAsMethod(quillName, operation.name, retT, retV);
                } else {
                    generateAsGetter(retT, retV);
                }
            } break;
            case "setter": {
                const retT = operation.idlType === undefined? "Unit"
                    : generateTypeRef(operation.idlType, symbols, true);
                const retV = operation.idlType === undefined? "undefined"
                    : valueToQuillValue("r", operation.idlType, symbols);
                if(operation.name.length > 0) {
                    const quillName = getMangledName(toSnakeCase(operation.name));
                    generateAsMethod(quillName, operation.name, retT, retV);
                } else {
                    generateAsSetter();
                }
            } break;
            case "deleter": {
                const retT = operation.idlType === undefined? "Unit"
                    : generateTypeRef(operation.idlType, symbols, true);
                const retV = operation.idlType === undefined? "undefined"
                    : valueToQuillValue("r", operation.idlType, symbols);
                if(operation.name.length > 0) {
                    const quillName = getMangledName(toSnakeCase(operation.name));
                    generateAsMethod(quillName, operation.name, retT, retV);
                } else {
                    generateAsDeleter();
                }
            } break;
            default: {
                console.warn(`Unhandled special operation type '${operation.special}'!`);
            }
        }       
    }
    // generation of JS conversions
    r += `pub fun ${symbol.name}::as_js(self: ${symbol.name}) -> JsValue = JsValue::unsafe_from[${symbol.name}](self)\n\n`
    r += `pub fun ${symbol.name}::from_js(v: JsValue) -> mut ${symbol.name} = JsValue::unsafe_as[mut ${symbol.name}](v)\n\n`
    return r;
}

function generateInterfaceConstants(symbol, symbols, tree) {
    let r = "";
    const members = collectSymbolMembers(symbol, symbols, tree);
    for(const member of members) {
        if(member.type !== "const") { continue; }
        r += `pub val ${symbol.name}::${member.name}: ${generateTypeRef(member.idlType)} = ${generateValue(member.value, member.idlType)}\n`;
    }
    if(r.length > 0) { r += "\n"; }
    return r;
}

function generateDictionary(symbol, symbols, tree) {
    let r = "";
    const fields = collectSymbolMembers(symbol, symbols, tree);
    const fieldTypeToQuill = field => {
        const t = generateTypeRef(field.idlType, symbols);
        if(field.required || field.idlType.nullable) { return t; }
        return `Option[${t}]`; 
    };
    const fieldNameToQuill = field => {
        return toSnakeCase(field.name);
    };
    // declaration
    r += `pub struct ${symbol.name}(`;
    let hadField = false;
    for(const field of fields) {
        if(hadField) { r += `,`; }
        hadField = true;
        r += `\n    ${fieldNameToQuill(field)}: ${fieldTypeToQuill(field)}`;
    }
    r += `\n)\n\n`;
    // default values
    r += `pub fun ${symbol.name}::default(`;
    r += fields
        .filter(field => field.default === null && field.required && !field.idlType.nullable)
        .map(field => `${fieldNameToQuill(field)}: ${fieldTypeToQuill(field)}`)
        .join(", ");
    r += `) -> mut ${symbol.name}\n`;
    r += `    = ${symbol.name}(`;
    r += fields
        .map(field => {
            if(field.default === null) {
                if(field.required && !field.idlType.nullable) {
                    return fieldNameToQuill(field);
                }
                return "Option::None";
            }
            const v = generateValue(field.default, field.idlType);
            if(field.required) { return v; }
            if(field.default.type === "null") { return v; }
            return `Option::Some(${v})`;
        })
        .join(", ");
    r += `)\n\n`;
    // inheritance
    if(symbol.inheritance !== null) {
        const baseSC = toSnakeCase(symbol.inheritance);
        r += `/// Converts a reference to '${symbol.name}' to a reference to '${symbol.inheritance}'.\n`;
        r += `/// This does not involve manipulating the object or reference.\n`;
        r += `pub ext fun ${symbol.name}::as_${baseSC}(self: ${symbol.name}) -> ${symbol.inheritance} = "return #var(self);"\n\n`;
        r += `/// Converts a mutable reference to '${symbol.name}' to a mutable reference to '${symbol.inheritance}'.\n`;
        r += `/// This does not involve manipulating the object or reference.\n`;
        r += `pub ext fun ${symbol.name}::as_m${baseSC}(self: mut ${symbol.name}) -> mut ${symbol.inheritance} = "return #var(self);"\n\n`;
        r += `/// Attempts to convert a reference to '${symbol.inheritance}' to a reference to '${symbol.name}'.\n`;
        r += `/// A 'base' that is not a reference to '${symbol.name}' RESULTS IN UNDEFINED BEHAVIOR.\n`;
        r += `/// This does not involve manipulating the object or reference.\n`;
        r += `pub ext fun ${symbol.name}::from_${baseSC}_unchecked(base: ${symbol.inheritance}) -> ${symbol.name} = "return #var(base);"\n\n`;
        r += `/// Attempts to convert a mutable reference to '${symbol.inheritance}' to a mutable reference to '${symbol.name}'.\n`;
        r += `/// A 'base' that is not a reference to '${symbol.name}' RESULTS IN UNDEFINED BEHAVIOR.\n`;
        r += `/// This does not involve manipulating the object or reference.\n`;
        r += `pub ext fun ${symbol.name}::from_m${baseSC}_unchecked(base: mut ${symbol.inheritance}) -> mut ${symbol.name} = "return #var(base);"\n\n`;
    }
    // from JS
    r += `pub ext fun ${symbol.name}::from_js(value: JsValue) -> mut ${symbol.name} = "\n`;
    r += `    const r = {};\n`;
    for(const field of fields) {
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
    r += `pub ext fun ${symbol.name}::as_js(self: ${symbol.name}) -> JsValue = "\n`;
    r += `    const r = {};\n`;
    for(const field of fields) {
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
        r += `pub val ${symbol.name}::${qv}: String = "${v.value}"\n`;
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
                if(value.value.startsWith("0x")) {
                    return parseInt(value.value.slice(2), 16).toString(10);
                }
                return value.value;
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
                console.warn("default values of type 'dictionary' are not implemented");
                return "Option::None";
        }
    };
    const genCast = () => {
        switch(type.idlType) {
            case "any":
            case "object":
                return `${gen()} |> as_js()`;
        }
        return gen();
    };
    if(value.type === "null") { return `Option::None`; }
    if(type.nullable) {
        return `Option::Some(${genCast()})`;
    }
    return genCast();
}

function generateTypeRefNamed(type, symbols, mutable = true) {
    switch(type.generic) {
        case "sequence":
            return `List[${generateTypeRef(type.idlType[0], symbols, mutable)}]`;
        default: if(type.generic) {
            // TODO!
            console.warn(`Generic '${type.generic}' is not yet implemented!`);
            return "JsValue";
        }
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
            console.warn(`Usage of type '${type.idlType}' is not yet implemented`);
            return "JsValue";
        case "Int8Array": case "Int16Array": case "Int32Array":
        case "Uint8Array": case "Uint16Array": case "Uint32Array":
        case "Uint8ClampedArray":
        case "BigInt64Array": case "BigUint64Array":
        case "Float16Array": case "Float32Array": case "Float64Array":
            // TODO!
            console.warn(`Usage of type '${type.idlType}' is not yet implemented`);
            return "JsValue";
        case "DataView":
            // TODO!
            console.warn(`Usage of type '${type.idlType}' is not yet implemented`);
            return "JsValue";
        case "object":
            return "JsObject";
        case "any":
            return "JsValue";
        case "undefined":
            return "Unit";
    }
    const symbol = symbols[type.idlType];
    if(symbol === undefined) {
        console.warn(`Unable to find type '${type.idlType}'!`);
        return "JsValue";
    }
    if(symbol.type === "enum") {
        return "String";
    }
    if(symbol.type === "typedef") {
        return generateTypeRef(symbol.idlType, symbols, mutable);
    }
    if(symbol.type === "callback") {
        const ret = generateTypeRef(symbol.idlType, symbols);
        const args = symbol.arguments
            .map(arg => generateTypeRef(arg.idlType, symbols))
            .join(", ");
        return `Fun(${args}) -> ${ret}`;
    }
    if(symbol.type === "callback interface") {
        const method = symbol.members
            .filter(member => member.type === "operation")
            .at(0);
        const ret = generateTypeRef(method.idlType, symbols);
        const args = method.arguments
            .map(arg => generateTypeRef(arg.idlType, symbols))
            .join(", ");
        return `Fun(${args}) -> ${ret}`;
    }
    if(mutable) { return `mut ${type.idlType}`; }
    return type.idlType;
}

function generateTypeRef(type, symbols, mutable = true) {
    if(type.nullable) {
        return `Option[${generateTypeRefNamed(type, symbols, mutable)}]`;
    }
    if(type.union) {
        return "JsValue";
    }
    return generateTypeRefNamed(type, symbols, mutable);
}

function generateOverloadTypeRefNamed(type, symbols, mutable = true) {
    switch(type.generic) {
        case "sequence":
            return `list_${generateOverloadTypeRef(type.idlType[0], symbols, mutable)}`;
        default: if(type.generic) {
            // TODO!
            console.warn(`Generic '${type.generic}' is not yet implemented!`);
            return "any";
        }
    }
    switch(type.idlType) {
        case "boolean":
            return "bool";
        case "byte": case "octet":
        case "short": case "unsigned short":
        case "long": case "unsigned long":
        case "long long": case "unsigned long long":
        case "bigint":
            return "int";
        case "float": case "unrestricted float":
        case "double": case "unrestricted double":
            return "flt";
        case "DOMString": case "ByteString": case "USVString":
            return "str";
        case "ArrayBuffer": case "SharedArrayBuffer":
            // TODO!
            console.warn(`Usage of type '${type.idlType}' is not yet implemented`);
            return "any";
        case "Int8Array": case "Int16Array": case "Int32Array":
        case "Uint8Array": case "Uint16Array": case "Uint32Array":
        case "Uint8ClampedArray":
        case "BigInt64Array": case "BigUint64Array":
        case "Float16Array": case "Float32Array": case "Float64Array":
            // TODO!
            console.warn(`Usage of type '${type.idlType}' is not yet implemented`);
            return "any";
        case "DataView":
            // TODO!
            console.warn(`Usage of type '${type.idlType}' is not yet implemented`);
            return "any";
        case "object":
            return "obj";
        case "any":
            return "any";
        case "undefined":
            return "unit";
    }
    const symbol = symbols[type.idlType];
    if(symbol === undefined) {
        console.warn(`Unable to find type '${type.idlType}'!`);
        return "any";
    }
    if(symbol.type === "enum") {
        return "str";
    }
    if(symbol.type === "typedef") {
        return generateOverloadTypeRefNamed(symbol.idlType, symbols, mutable);
    }
    if(symbol.type === "callback") {
        const ret = generateOverloadTypeRefNamed(symbol.idlType, symbols);
        const args = symbol.arguments
            .map(arg => `_${generateOverloadTypeRefNamed(arg.idlType, symbols)}`)
            .join("");
        return `f${args}_${ret}`;
    }
    if(symbol.type === "callback interface") {
        const method = symbol.members
            .filter(member => member.type === "operation")
            .at(0);
        const ret = generateOverloadTypeRefNamed(method.idlType, symbols);
        const args = method.arguments
            .map(arg => `_${generateOverloadTypeRefNamed(arg.idlType, symbols)}`)
            .join("");
        return `f${args}_${ret}`;
    }
    const t = toSnakeCase(type.idlType);
    if(mutable) { return `m${t}`; }
    return t;
}

function generateOverloadTypeRef(type, symbols, mutable = true) {
    if(type.nullable) {
        return `o${generateOverloadTypeRefNamed(type, symbols, mutable)}`;
    }
    if(type.union) {
        return "any";
    }
    return generateOverloadTypeRefNamed(type, symbols, mutable);
}

function rawToQuillValue(value, type, symbols) {
    switch(type.generic) {
        case "sequence":
            return `#fun(List::from_js[${generateTypeRef(type.idlType[0], symbols)}])(${value})`;
        default: if(type.generic) {
            // TODO!
            console.warn(`Generic '${type.generic}' is not yet implemented!`);
            return value;
        }
    }
    if(type.generic) {
        // type.idlType is an array!
        // TODO!
        console.warn(`Generics are not yet implemented!`);
        return value;
    }
    switch(type.idlType) {
        case "boolean":
            return `#fun(Bool::from_js)(${value})`;
        case "byte": case "octet":
        case "short": case "unsigned short":
        case "long": case "unsigned long":
        case "long long": case "unsigned long long":
            return `#fun(Int::from_js)(${value})`;
        case "bigint":
            return `#fun(Int::from_js)(${value})`;
        case "float": case "unrestricted float":
        case "double": case "unrestricted double":
            return `#fun(Float::from_js)(${value})`;
        case "DOMString": case "ByteString": case "USVString":
            return `#fun(String::from_js)(${value})`;
        case "ArrayBuffer": case "SharedArrayBuffer":
            return value; // JsValue
        case "Int8Array": case "Int16Array": case "Int32Array":
        case "Uint8Array": case "Uint16Array": case "Uint32Array":
        case "Uint8ClampedArray":
        case "BigInt64Array": case "BigUint64Array":
        case "Float16Array": case "Float32Array": case "Float64Array":
            return value; // JsValue
        case "DataView":
            return value; // JsValue
        case "object":
        case "any":
            return value; // JsValue
        case "undefined":
            return `#fun(Unit::from_js)(${value})`;;
    }
    const symbol = symbols[type.idlType];
    if(symbol === undefined) {
        console.warn(`Unable to find type '${type.idlType}'!`);
        return value;
    }
    if(symbol.type === "enum") {
        return `#fun(String::from_js)(${value})`; // string
    }
    if(symbol.type === "typedef") {
        return valueToQuillValue(value, symbol.idlType, symbols);
    }
    const functionToQuill = (f, v) => {
        const argNames = f.arguments
            .map((arg, i) => `p${i}`);
        const argValues = f.arguments
            .map((arg, i) => valueToJsValue(`p${i}`, arg.idlType, symbols));
        return `((${argNames.join(", ")}) => { const r = ${v}(${argValues.join(", ")}); return ${valueToQuillValue("r", f.idlType, symbols)}; })`;
    };
    if(symbol.type === "callback") {
        return functionToQuill(symbol, value);
    }
    if(symbol.type === "callback interface") {
        const method = symbol.members
            .filter(member => member.type === "operation")
            .at(0);
        return `((...a) => ${functionToQuill(method, `${value}.${method.name}`)}(...a))`;
    }
    return `#fun(${symbol.name}::from_js)(${value})`;
}

function optionalToQuillValue(value, type, symbols) {
    const t = generateTypeRefNamed(type, symbols);
    return `#fun(Option::from_js[${t}])(${value})`;
}

function valueToQuillValue(value, type, symbols) {
    if(type.nullable) {
        return optionalToQuillValue(value, type, symbols);
    }
    if(type.union) {
        return value;
    }
    return rawToQuillValue(value, type, symbols);
}

function rawToJsValue(value, type, symbols) {
    switch(type.generic) {
        case "sequence":
            return `#fun(List::as_js[${generateTypeRef(type.idlType[0], symbols)}])(${value})`;
        default: if(type.generic) {
            // TODO!
            console.warn(`Generic '${type.generic}' is not yet implemented!`);
            return value;
        }
    }
    switch(type.idlType) {
        case "boolean":
            return `#fun(Bool::as_js)(${value})`;
        case "byte": case "octet":
        case "short": case "unsigned short":
        case "long": case "unsigned long":
        case "long long": case "unsigned long long":
            return `#fun(Int::as_js)(${value})`;
        case "bigint":
            return `#fun(Int::as_js_bigint)(${value})`;
        case "float": case "unrestricted float":
        case "double": case "unrestricted double":
            return `#fun(Float::as_js)(${value})`;
        case "DOMString": case "ByteString": case "USVString":
            return `#fun(String::as_js)(${value})`;
        case "ArrayBuffer": case "SharedArrayBuffer":
            return value; // JsValue
        case "Int8Array": case "Int16Array": case "Int32Array":
        case "Uint8Array": case "Uint16Array": case "Uint32Array":
        case "Uint8ClampedArray":
        case "BigInt64Array": case "BigUint64Array":
        case "Float16Array": case "Float32Array": case "Float64Array":
            return value; // JsValue
        case "DataView":
            return value; // JsValue
        case "object":
        case "any":
            return value; // JsValue
        case "undefined":
            return `#fun(Unit::as_js)(${value})`;
    }
    const symbol = symbols[type.idlType];
    if(symbol === undefined) {
        console.warn(`Unable to find type '${type.idlType}'!`);
        return value;
    }
    if(symbol.type === "enum") {
        return value;
    }
    if(symbol.type === "typedef") {
        return valueToJsValue(value, symbol.idlType, symbols);
    }
    const functionToJs = f => {
        const argNames = f.arguments
            .map((arg, i) => `p${i}`);
        const argValues = f.arguments
            .map((arg, i) => valueToQuillValue(`p${i}`, arg.idlType, symbols));
        return `((${argNames.join(", ")}) => { const r = ${value}(${argValues.join(", ")}); return ${valueToJsValue("r", f.idlType, symbols)}; })`;
    };
    if(symbol.type === "callback") {
        return functionToJs(symbol);
    }
    if(symbol.type === "callback interface") {
        const method = symbol.members
            .filter(member => member.type === "operation")
            .at(0);
        return `{ ${method.name}: ${functionToJs(method)} }`;
    }
    return `#fun(${symbol.name}::as_js)(${value})`;
}

function optionalToJsValue(value, type, symbols) {
    const t = generateTypeRefNamed(type, symbols);
    return `#fun(Option::as_js[${t}])(${value})`;
}

function valueToJsValue(value, type, symbols) {
    if(type.nullable) {
        return optionalToJsValue(value, type, symbols);
    }
    if(type.union) {
        return value;
    }
    return rawToJsValue(value, type, symbols);
}

main();