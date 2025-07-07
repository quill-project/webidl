
const fs = require("fs");
const path = require('path');
const idl = require("webidl2");

function collectFiles(dir, exts) {
    let files = [];
    for(const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.resolve(dir, f.name);
        if(f.isDirectory()) {
            files.push(...collectFiles(fp, exts));
        } else if(f.isFile() && exts.includes(path.extname(f.name))) {
            files.push(fp);
        }
    }
    return files;
}

const sanitizeInput = input => input.replaceAll("toString", "");

function main() {
    const files = collectFiles("./sources", [".idl", ".webidl"]);
    const module = process.argv.at(2); // node index.js <MODULE_NAME>
    const tree = [];
    const symbols = {};
    const errors = [];
    for(const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        let declarations;
        try {
            declarations = idl.parse(sanitizeInput(content), { sourceName: file });
        } catch(e) {
            errors.push(e.toString());
            continue;
        }
        for(const def of declarations) {
            tree.push(def);
            if(!def.name) { continue; }
            symbols[def.name] = def;
        }
    }
    console.log(errors);
    let result = `\nmod ${module}\n\nuse js::*\n\n`;
    const generated = new Set();
    for(const symbol of tree) {
        result += generateSymbol(symbol, symbols, tree, generated);
    }
    fs.writeFileSync("output.quill", result);
}

// See https://github.com/quill-project/compiler/blob/main/src/frontend/lexer.quill#L53
// for a list of all Quill keywords
const quillKeywords = new Set([
    "if", "else", "ext", "fun", "return", "continue", "break",
    "val", "mut", "mod", "use", "as", "pub", "struct", "enum", "match",
    "while", "for",

    "true", "false", "unit"
]);

const mangleQuillName = name => {
    if(!quillKeywords.has(name)) { return name; }
    return `${name}_`;
};

const isValidIdentifier = name => {
    if(!name) { return true; }
    const charIsValid = c => c === "_"
        || ("a" <= c && c <= "z")
        || ("A" <= c && c <= "Z")
        || ("0" <= c && c <= "9");
    return [...name].every(charIsValid);
};

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

const toPascalCase = name => [...name]
    .map((c, i) => {
        const isFirst = i === 0;
        const isLower = t => "a" <= t && t <= "z";
        const isUpper = t => "A" <= t && t <= "Z";
        const isAlpha = t => isLower(t) || isUpper(t);
        const isNumeric = t => "0" <= t && t <= "9";
        if(isNumeric(c) && isFirst) { return "_" + c; }
        if(isNumeric(c)) { return c; }
        if(!isAlpha(c)) { return ""; }
        const preIsAlpha = !isFirst && isAlpha(name[i - 1]);
        return preIsAlpha? c : c.toUpperCase();
    })
    .join("");

const wasGenerated = (generated, thing) => {
    if(generated.has(thing)) { return true; }
    generated.add(thing);
    return false;
};

function generateSymbol(symbol, symbols, tree, gen) {
    switch(symbol.type) {
        case "dictionary": return generateDictionary(symbol, symbols, tree, gen);
        case "interface": return generateInterface(symbol, symbols, tree, gen)
            + generateInterfaceConstants(symbol, symbols, tree, gen);
        case "interface mixin": return ""; // Nothing to do, magic happens in 'interface'
        case "includes": // Nothing to do, magic happens in 'interface'
        case "callback": return ""; // nothing to do, magic happens in type ref generator function
        case "callback interface": return generateInterfaceConstants(symbol, symbols, tree, gen);
        case "typedef": return ""; // nothing to do, magic happens in type ref generator function
        case "enum": return generateEnum(symbol, gen);
    }
    console.warn(`Definitions of type '${symbol.type}' are not implemented`);
    return `// TODO: Definitions of type '${symbol.type}'\n\n`;
}

function collectSymbolMembers(symbol, symbols, tree) {
    const collected = [];
    let searched = symbol;
    for(;;) {
        for(const member of searched.members) {
            if(member.type === "constructor" && searched !== symbol) {
                continue;
            }
            collected.push(member);
        }
        if(!searched.inheritance) { break; }
        const base = symbols[searched.inheritance];
        if(base === undefined) {
            console.warn(`Could not find symbol '${searched.inheritance}'!`);
            break;
        }
        searched = base;
    }
    for(const def of tree) {
        if(def.type !== "includes" || def.target !== symbol.name) { continue; }
        const included = symbols[def.includes];
        collected.push(...included.members);
    }
    return collected.filter(member => isValidIdentifier(member.name));
}

function generateInterface(symbol, symbols, tree, gen) {
    let r = "";
    const members = collectSymbolMembers(symbol, symbols, tree);
    if(!wasGenerated(gen, symbol.name)) {
        r += `struct ${symbol.name}()\n\n`;
    }
    // generation of inheritance casts
    if(symbol.inheritance !== null) {
        let base = symbol.inheritance;
        while(base !== null) {
            const baseSymbol = symbols[base];
            if(baseSymbol === undefined) { break; }
            const baseSC = toSnakeCase(base);
            if(!wasGenerated(gen, `${symbol.name}::as_${baseSC}`)) {
                r += `/// Converts a reference to '${symbol.name}' to a reference to '${base}'.\n`;
                r += `/// This does not involve manipulating the object or reference.\n`;
                r += `pub ext fun ${symbol.name}::as_${baseSC}(self: ${symbol.name}) -> ${base} = "return #var(self);"\n\n`;
            }
            if(!wasGenerated(gen, `${symbol.name}::as_m${baseSC}`)) {
                r += `/// Converts a mutable reference to '${symbol.name}' to a mutable reference to '${base}'.\n`;
                r += `/// This does not involve manipulating the object or reference.\n`;
                r += `pub ext fun ${symbol.name}::as_m${baseSC}(self: mut ${symbol.name}) -> mut ${base} = "return #var(self);"\n\n`;
            }
            if(!wasGenerated(gen, `${symbol.name}::from_${baseSC}`)) {
                r += `/// Attempts to convert a reference to '${base}' to a reference to '${symbol.name}'.\n`;
                r += `/// The conversion may fail and panic if 'base' is not a reference to '${symbol.name}' or if the given instance is user-implemented.\n`;
                r += `/// This does not involve manipulating the object or reference.\n`;
                r += `pub ext fun ${symbol.name}::from_${baseSC}(base: ${base}) -> ${symbol.name} = "\n`;
                r += `    if(#var(base) instanceof ${symbol.name}) { return #var(base); }\n`
                r += `    #fun(panic[Unit])(\\"Failed to downcast '${base}' to '${symbol.name}'!\\");\n`
                r += `"\n\n`
            }
            if(!wasGenerated(gen, `${symbol.name}::from_m${baseSC}`)) {
                r += `/// Attempts to convert a mutable reference to '${base}' to a mutable reference to '${symbol.name}'.\n`;
                r += `/// The conversion may fail and panic if 'base' is not a reference to '${symbol.name}' or if the given instance is user-implemented.\n`;
                r += `/// This does not involve manipulating the object or reference.\n`;
                r += `pub ext fun ${symbol.name}::from_m${baseSC}(base: mut ${base}) -> mut ${symbol.name} = "\n`;
                r += `    if(#var(base) instanceof ${symbol.name}) { return #var(base); }\n`
                r += `    #fun(panic[Unit])(\\"Failed to downcast '${base}' to '${symbol.name}'!\\");\n`
                r += `"\n\n`;
            }
            base = baseSymbol.inheritance;
        }
    }
    const generateArgumentDecl = arg => {
        const name = mangleQuillName(toSnakeCase(arg.name));
        const type = generateTypeRef(arg.idlType, symbols, true);
        if(!arg.variadic) { return `${name}: ${type}`; }
        return `...${name}: List[${type}]`;
    };
    const generateArgumentToJs = arg => {
        const qv = `#var(${mangleQuillName(toSnakeCase(arg.name))})`;
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
        if(wasGenerated(gen, `${symbol.name}::${name}`)) { continue; }
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
        if(attribute.name.length === 0) { continue; }
        const nameSC = mangleQuillName(toSnakeCase(attribute.name));
        const valueT = generateTypeRef(attribute.idlType, symbols, true);
        const value = `${jsAccessed}.${attribute.name}`;
        if(!wasGenerated(gen, `${symbol.name}::${nameSC}`)) {
            r += `pub ext fun ${symbol.name}::${nameSC}(${selfArgRead}) -> ${valueT}\n`;
            r += `    = "return ${valueToQuillValue(value, attribute.idlType, symbols)};"\n\n`;
        }
        if(!attribute.readonly && !wasGenerated(gen, `${symbol.name}::set_${nameSC}`)) {
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
            if(overloads.length === 1) { return mangleQuillName(quillName); }
            if(operation.arguments.length === 0) { return mangleQuillName(quillName); }
            return quillName + "_" + operation.arguments
                .map(arg => generateOverloadTypeRef(arg.idlType, symbols, true))
                .join("_");
        };
        const generateAsMethod = (quillName, jsName, retT, retV) => {
            if(jsName.length === 0) { return; }
            if(wasGenerated(gen, `${symbol.name}::${quillName}`)) { return; }
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
            if(jsName.length === 0) { return; }
            if(wasGenerated(gen, `${symbol.name}::${quillName}`)) { return; }
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
            const quillName = getMangledName("get");
            if(wasGenerated(gen, `${symbol.name}::${quillName}`)) { return; }
            r += `pub ext fun ${symbol.name}::${quillName}(__self: ${symbol.name}`;
            r += operation.arguments.map(a => `, ${generateArgumentDecl(a)}`).join("");
            r += `) -> ${retT} = "\n`;
            r += `    const r = ${symbol.name}[${generateArgumentToJs(operation.arguments[0])}];\n`;
            r += `    return ${retV};\n`
            r += `"\n\n`;
        };
        const generateAsSetter = () => {
            const key = generateArgumentToJs(operation.arguments[0]);
            const value = generateArgumentToJs(operation.arguments[1]);
            const quillName = getMangledName("set");
            if(wasGenerated(gen, `${symbol.name}::${quillName}`)) { return; }
            r += `pub ext fun ${symbol.name}::${quillName}(__self: mut ${symbol.name}`;
            r += operation.arguments.map(a => `, ${generateArgumentDecl(a)}`).join("");
            r += `) = "\n`;
            r += `    ${symbol.name}[${key}] = ${value};\n`;
            r += `"\n\n`;
        };
        const generateAsDeleter = () => {
            const quillName = getMangledName("remove");
            if(wasGenerated(gen, `${symbol.name}::${quillName}`)) { return; }
            r += `pub ext fun ${symbol.name}::${quillName}(__self: mut ${symbol.name}`;
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
    if(!wasGenerated(gen, `${symbol.name}::as_js`)) {
        r += `pub fun ${symbol.name}::as_js(self: ${symbol.name}) -> JsValue = JsValue::unsafe_from[${symbol.name}](self)\n\n`
    }
    if(!wasGenerated(gen, `${symbol.name}::from_js`)) {
        r += `pub fun ${symbol.name}::from_js(v: JsValue) -> mut ${symbol.name} = JsValue::unsafe_as[mut ${symbol.name}](v)\n\n`
    }
    return r;
}

function generateInterfaceConstants(symbol, symbols, tree, gen) {
    let r = "";
    const members = collectSymbolMembers(symbol, symbols, tree);
    for(const member of members) {
        if(member.type !== "const") { continue; }
        if(member.name.length === 0) { continue; }
        const quillName = mangleQuillName(toSnakeCase(member.name));
        if(wasGenerated(gen, `${symbol.name}::${quillName}`)) { continue; }
        r += `pub val ${symbol.name}::${quillName}: ${generateTypeRef(member.idlType, symbols)} = ${generateValue(member.value, member.idlType, symbols)}\n`;
    }
    if(r.length > 0) { r += "\n"; }
    return r;
}

function generateDictionary(symbol, symbols, tree, gen) {
    let r = "";
    const fields = collectSymbolMembers(symbol, symbols, tree);
    const fieldTypeToQuill = field => {
        const t = generateTypeRef(field.idlType, symbols);
        if(field.required || field.idlType.nullable) { return t; }
        return `Option[${t}]`; 
    };
    const fieldNameToQuill = field => {
        return mangleQuillName(toSnakeCase(field.name));
    };
    // declaration
    if(!wasGenerated(gen, symbol.name)) {
        r += `pub struct ${symbol.name}(`;
        let hadField = false;
        for(const field of fields) {
            if(hadField) { r += `,`; }
            hadField = true;
            r += `\n    ${fieldNameToQuill(field)}: ${fieldTypeToQuill(field)}`;
        }
        r += `\n)\n\n`;
    }
    // default values
    if(!wasGenerated(gen, `${symbol.name}::default`)) {
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
                const v = generateValue(field.default, field.idlType, symbols);
                if(field.required) { return v; }
                if(field.default.type === "null") { return v; }
                if(field.idlType.nullable) { return v; }
                return `Option::Some(${v})`;
            })
            .join(", ");
        r += `)\n\n`;
    }
    // inheritance
    if(symbol.inheritance !== null && symbols[symbol.inheritance] !== undefined) {
        const baseSC = toSnakeCase(symbol.inheritance);
        if(!wasGenerated(gen, `${symbol.name}::as_${baseSC}`)) {
            r += `/// Converts a reference to '${symbol.name}' to a reference to '${symbol.inheritance}'.\n`;
            r += `/// This does not involve manipulating the object or reference.\n`;
            r += `pub ext fun ${symbol.name}::as_${baseSC}(self: ${symbol.name}) -> ${symbol.inheritance} = "return #var(self);"\n\n`;
        }
        if(!wasGenerated(gen, `${symbol.name}::as_m${baseSC}`)) {
            r += `/// Converts a mutable reference to '${symbol.name}' to a mutable reference to '${symbol.inheritance}'.\n`;
            r += `/// This does not involve manipulating the object or reference.\n`;
            r += `pub ext fun ${symbol.name}::as_m${baseSC}(self: mut ${symbol.name}) -> mut ${symbol.inheritance} = "return #var(self);"\n\n`;
        }
        if(!wasGenerated(gen, `${symbol.name}::from_${baseSC}_unchecked`)) {
            r += `/// Attempts to convert a reference to '${symbol.inheritance}' to a reference to '${symbol.name}'.\n`;
            r += `/// A 'base' that is not a reference to '${symbol.name}' RESULTS IN UNDEFINED BEHAVIOR.\n`;
            r += `/// This does not involve manipulating the object or reference.\n`;
            r += `pub ext fun ${symbol.name}::from_${baseSC}_unchecked(base: ${symbol.inheritance}) -> ${symbol.name} = "return #var(base);"\n\n`;
        }
        if(!wasGenerated(gen, `${symbol.name}::from_m${baseSC}_unchecked`)) {
            r += `/// Attempts to convert a mutable reference to '${symbol.inheritance}' to a mutable reference to '${symbol.name}'.\n`;
            r += `/// A 'base' that is not a reference to '${symbol.name}' RESULTS IN UNDEFINED BEHAVIOR.\n`;
            r += `/// This does not involve manipulating the object or reference.\n`;
            r += `pub ext fun ${symbol.name}::from_m${baseSC}_unchecked(base: mut ${symbol.inheritance}) -> mut ${symbol.name} = "return #var(base);"\n\n`;
        }
    }
    // from JS
    if(!wasGenerated(gen, `${symbol.name}::from_js`)) {
        r += `pub ext fun ${symbol.name}::from_js(value: JsValue) -> mut ${symbol.name} = "\n`;
        r += `    const r = {};\n`;
        for(const field of fields) {
            const n = fieldNameToQuill(field);
            const v = `#var(value).${field.name}`;
            const qv = field.required
                ? valueToQuillValue(v, field.idlType, symbols)
                : optionalToQuillValue(v, field.idlType, symbols);
            r += `    r.m_${n} = ${qv};\n`;
        }
        r += `    return r;\n`;
        r += `"\n\n`;
    }
    // as JS
    if(!wasGenerated(gen, `${symbol.name}::as_js`)) {
        r += `pub ext fun ${symbol.name}::as_js(self: ${symbol.name}) -> JsValue = "\n`;
        r += `    const r = {};\n`;
        for(const field of fields) {
            const n = fieldNameToQuill(field);
            const v = `#var(self).m_${n}`;
            const jv = field.required
                ? valueToJsValue(v, field.idlType, symbols)
                : `#fun(Option::as_js_undef[${generateTypeRefNamed(field.idlType, symbols)}])(${v})`;
            r += `    r.${field.name} = ${jv};\n`;
        }
        r += `    return r;\n`;
        r += `"\n\n`;
    }
    return r;
}

function generateEnum(symbol, gen) {
    let r = "";
    for(const v of symbol.values) {
        if(v.value.length === 0) { continue; }
        const qv = toPascalCase(v.value);
        if(wasGenerated(gen, `${symbol.name}::${qv}`)) { continue; }
        r += `pub val ${symbol.name}::${qv}: String = "${v.value}"\n`;
    }
    r += "\n";
    return r;
}

function generateValue(value, type, symbols) {
    const tf = generateTypeRef(type, symbols, false);
    const tn = generateTypeRefNamed(type, symbols, false);
    const gen = () => {
        switch(value.type) {
            case "string":
                return `"${value.value}"`;
            case "number": {
                const r = value.value.startsWith("0x")
                    ? parseInt(value.value.slice(2), 16).toString(10)
                    : value.value;
                return tn === "Int"? r
                    : r.includes(".")? r
                    : r + ".0";
            }
            case "boolean":
                return value.value;
            case "null":
                return "Option::None";
            case "Infinity":
                return value.negative? "Float::NEG_INF" : "Float::INF";
            case "NaN":
                return "Float::NAN";
            case "sequence": {
                if(tn === "JsValue") { return "EMPTY_LIST"; }
                return "List::empty()"
            }
            case "dictionary": {
                if(type.idlType === "object") { return "JsObject::empty()"; }
                return `${tn}::from_js(JsObject::empty() |> as_js())`;
            }
        }
    };
    const genCast = () => {
        if(tn === "JsValue") {
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
    if(type.union) {
        return "JsValue";
    }
    switch(type.generic) {
        case "sequence":
            return `List[${generateTypeRef(type.idlType[0], symbols, mutable)}]`;
        case "Promise":
            return `Promise[${generateTypeRef(type.idlType[0], symbols, mutable)}]`;
        case "record":
            return `Record[${generateTypeRef(type.idlType[1], symbols, mutable)}]`;
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
        case "void":
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
    return generateTypeRefNamed(type, symbols, mutable);
}

function generateOverloadTypeRefNamed(type, symbols, mutable = true) {
    if(type.union) {
        return "any";
    }
    switch(type.generic) {
        case "sequence":
            return `list_${generateOverloadTypeRef(type.idlType[0], symbols, mutable)}`;
        case "Promise":
            return `prom_${generateOverloadTypeRef(type.idlType[0], symbols, mutable)}`;
        case "record":
            return `rec_${generateOverloadTypeRef(type.idlType[1], symbols, mutable)}`;
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
        case "void":
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
    return generateOverloadTypeRefNamed(type, symbols, mutable);
}

function rawToQuillValue(value, type, symbols) {
    if(type.union) {
        return value;
    }
    switch(type.generic) {
        case "sequence":
            return `#fun(List::from_js[${generateTypeRef(type.idlType[0], symbols)}])(${value})`;
        case "Promise":
            return `#fun(Promise::from_js[${generateTypeRef(type.idlType[0], symbols)}])(${value})`;
        case "record":
            return `#fun(Record::from_js[${generateTypeRef(type.idlType[1], symbols)}])(${value})`;
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
        case "void":
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
    return rawToQuillValue(value, type, symbols);
}

function rawToJsValue(value, type, symbols) {
    if(type.union) {
        return value;
    }
    switch(type.generic) {
        case "sequence":
            return `#fun(List::as_js[${generateTypeRef(type.idlType[0], symbols)}])(${value})`;
        case "Promise":
            return `#fun(Promise::as_js[${generateTypeRef(type.idlType[0], symbols)}])(${value})`;
        case "record":
            return `#fun(Record::as_js[${generateTypeRef(type.idlType[1], symbols)}])(${value})`;
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
        case "void":
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
    return rawToJsValue(value, type, symbols);
}

main();