import ts from 'typescript'
import * as path from 'path'
import * as fs from 'fs'
import * as vueCompiler from 'vue-template-compiler'

function isVueFile(fileName: string) {
  return /\.vue(\.ts)?$/.test(fileName)
}

function parseTSFromVueFile(fileName: string) {
  try {
    const content = fs.readFileSync(fileName, 'utf-8')
    const { script } = vueCompiler.parseComponent(content, { pad: 'line' })
    if (script && /^tsx?$/.test(script.lang || '')) {
      return script
    }

    return null
  } catch (e) {
    return null
  }
}

function resolveNonTsModuleName(moduleName: string, containingFile: string, basedir: string, options: ts.CompilerOptions) {
  const baseUrl = options.baseUrl ? options.baseUrl : basedir;
  const discardedSymbols = ['.', '..', '/'];
  const wildcards: string[] = [];
  if (options.paths) {
    Object.keys(options.paths).forEach(key => {
      const pathSymbol = key[0];
      if (discardedSymbols.indexOf(pathSymbol) < 0 &&
        wildcards.indexOf(pathSymbol) < 0) {
        wildcards.push(pathSymbol);
      }
    });
  }
  else {
    wildcards.push('@');
  }
  const isRelative = !path.isAbsolute(moduleName);
  let correctWildcard: string = '';
  wildcards.forEach(wildcard => {
    if (moduleName.substr(0, 2) === `${wildcard}/`) {
      correctWildcard = wildcard;
    }
  });
  if (correctWildcard) {
    const substitution = options.paths
      ? options.paths[`${correctWildcard}/*`][0].replace('*', '')
      : 'src';
    moduleName = path.resolve(baseUrl, substitution, moduleName.substr(2));
  }
  else if (isRelative) {
    moduleName = path.resolve(path.dirname(containingFile), moduleName);
  }
  return moduleName;
}

export default function createHost(compilerOptions: ts.CompilerOptions) {
  const host = ts.createCompilerHost(compilerOptions);
  const realGetSourceFile = host.getSourceFile;

  // We need a host that can parse Vue SFCs (single file components).
  host.getSourceFile = (filePath, languageVersion, onError) => {
    // first check if watcher is watching file - if not - check it's mtime
    // get source file only if there is no source in files register
    // get typescript contents from Vue file
    if (isVueFile(filePath)) {
      const { content, lang = 'js' } = parseTSFromVueFile(filePath) || { content: '', lang: 'js' }
      const langUpper: any = lang.toUpperCase()
      const contentLang: any = ts.ScriptKind[langUpper]
      return ts.createSourceFile(filePath, content, ts.ScriptTarget.ESNext, true, contentLang)
    } else {
      return realGetSourceFile.call(host, filePath, languageVersion, onError)
    }
  };
  // We need a host with special module resolution for Vue files.
  host.resolveModuleNames = (moduleNames, containingFile) => {
    const resolvedModules = [];
    for (const moduleName of moduleNames) {
      // Try to use standard resolution.
      const { resolvedModule } = ts.resolveModuleName(moduleName, containingFile, compilerOptions, {
        fileExists(fileName) {
          if (fileName.endsWith('.vue.ts')) {
            return (host.fileExists(fileName.slice(0, -3)) ||
              host.fileExists(fileName));
          }
          else {
            return host.fileExists(fileName);
          }
        },
        readFile(fileName) {
          // This implementation is not necessary. Just for consistent behavior.
          if (fileName.endsWith('.vue.ts') && !host.fileExists(fileName)) {
            return host.readFile(fileName.slice(0, -3));
          }
          else {
            return host.readFile(fileName);
          }
        }
      });
      if (resolvedModule) {
        if (resolvedModule.resolvedFileName.endsWith('.vue.ts') &&
          !host.fileExists(resolvedModule.resolvedFileName)) {
          resolvedModule.resolvedFileName = resolvedModule.resolvedFileName.slice(0, -3);
        }
        resolvedModules.push(resolvedModule);
      }
      else {
        // For non-ts extensions.
        const absolutePath = resolveNonTsModuleName(moduleName, containingFile, '.', compilerOptions);
        if (isVueFile(moduleName)) {
          resolvedModules.push({
            resolvedFileName: absolutePath,
            extension: '.ts'
          });
        }
        else {
          resolvedModules.push({
            // If the file does exist, return an empty string (because we assume user has provided a ".d.ts" file for it).
            resolvedFileName: host.fileExists(absolutePath)
              ? ''
              : absolutePath,
            extension: '.ts'
          });
        }
      }
    }
    return resolvedModules;
  };

  return host
}
