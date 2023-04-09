// This file is executed in every realm that is created by Node.js, including
// the context of main thread, worker threads, and ShadowRealms.
// Only per-realm internal states and bindings should be bootstrapped in this
// file and no globals should be exposed to the user code.
//
// This file creates the internal module & binding loaders used by built-in
// modules. In contrast, user land modules are loaded using
// lib/internal/modules/cjs/loader.js (CommonJS Modules) or
// lib/internal/modules/esm/* (ES Modules).
//
// This file is compiled and run by node.cc before bootstrap/node.js
// was called, therefore the loaders are bootstrapped before we start to
// actually bootstrap Node.js. It creates the following objects:
//
// C++ binding loaders:
// - process.binding(): the legacy C++ binding loader, accessible from user land
//   because it is an object attached to the global process object.
//   These C++ bindings are created using NODE_BUILTIN_MODULE_CONTEXT_AWARE()
//   and have their nm_flags set to NM_F_BUILTIN. We do not make any guarantees
//   about the stability of these bindings, but still have to take care of
//   compatibility issues caused by them from time to time.
// - process._linkedBinding(): intended to be used by embedders to add
//   additional C++ bindings in their applications. These C++ bindings
//   can be created using NODE_MODULE_CONTEXT_AWARE_CPP() with the flag
//   NM_F_LINKED.
// - internalBinding(): the private internal C++ binding loader, inaccessible
//   from user land unless through `require('internal/test/binding')`.
//   These C++ bindings are created using NODE_BINDING_CONTEXT_AWARE_INTERNAL()
//   and have their nm_flags set to NM_F_INTERNAL.
//
// Internal JavaScript module loader:
// - BuiltinModule: a minimal module system used to load the JavaScript core
//   modules found in lib/**/*.js and deps/**/*.js. All core modules are
//   compiled into the node binary via node_javascript.cc generated by js2c.py,
//   so they can be loaded faster without the cost of I/O. This class makes the
//   lib/internal/*, deps/internal/* modules and internalBinding() available by
//   default to core modules, and lets the core modules require itself via
//   require('internal/bootstrap/realm') even when this file is not written in
//   CommonJS style.
//
// Other objects:
// - process.moduleLoadList: an array recording the bindings and the modules
//   loaded in the process and the order in which they are loaded.

'use strict';

// This file is compiled as if it's wrapped in a function with arguments
// passed by node::RunBootstrapping()
/* global process, getLinkedBinding, getInternalBinding, primordials */

const {
  ArrayFrom,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  Error,
  ObjectDefineProperty,
  ObjectKeys,
  ObjectPrototypeHasOwnProperty,
  ObjectSetPrototypeOf,
  ReflectGet,
  SafeMap,
  SafeSet,
  String,
  StringPrototypeStartsWith,
  StringPrototypeSlice,
  TypeError,
} = primordials;

// Set up process.moduleLoadList.
const moduleLoadList = [];
ObjectDefineProperty(process, 'moduleLoadList', {
  __proto__: null,
  value: moduleLoadList,
  configurable: true,
  enumerable: true,
  writable: false,
});


// internalBindingAllowlist contains the name of internalBinding modules
// that are allowed for access via process.binding()... This is used
// to provide a transition path for modules that are being moved over to
// internalBinding.
const internalBindingAllowlist = new SafeSet([
  'async_wrap',
  'buffer',
  'cares_wrap',
  'config',
  'constants',
  'contextify',
  'crypto',
  'fs',
  'fs_event_wrap',
  'http_parser',
  'icu',
  'inspector',
  'js_stream',
  'natives',
  'os',
  'pipe_wrap',
  'process_wrap',
  'signal_wrap',
  'spawn_sync',
  'stream_wrap',
  'tcp_wrap',
  'tls_wrap',
  'tty_wrap',
  'udp_wrap',
  'url',
  'util',
  'uv',
  'v8',
  'zlib',
]);

const runtimeDeprecatedList = new SafeSet([
  'async_wrap',
  'crypto',
  'http_parser',
  'signal_wrap',
  'url',
  'v8',
]);

const legacyWrapperList = new SafeSet([
  'util',
]);

// The code bellow assumes that the two lists must not contain any modules
// beginning with "internal/".
// Modules that can only be imported via the node: scheme.
const schemelessBlockList = new SafeSet([
  'test',
]);
// Modules that will only be enabled at run time.
const experimentalModuleList = new SafeSet();

// Set up process.binding() and process._linkedBinding().
{
  const bindingObj = { __proto__: null };

  process.binding = function binding(module) {
    module = String(module);
    // Deprecated specific process.binding() modules, but not all, allow
    // selective fallback to internalBinding for the deprecated ones.
    if (internalBindingAllowlist.has(module)) {
      if (runtimeDeprecatedList.has(module)) {
        runtimeDeprecatedList.delete(module);
        process.emitWarning(
          `Access to process.binding('${module}') is deprecated.`,
          'DeprecationWarning',
          'DEP0111');
      }
      if (legacyWrapperList.has(module)) {
        return requireBuiltin('internal/legacy/processbinding')[module]();
      }
      return internalBinding(module);
    }
    // eslint-disable-next-line no-restricted-syntax
    throw new Error(`No such module: ${module}`);
  };

  process._linkedBinding = function _linkedBinding(module) {
    module = String(module);
    let mod = bindingObj[module];
    if (typeof mod !== 'object')
      mod = bindingObj[module] = getLinkedBinding(module);
    return mod;
  };
}

// Set up internalBinding() in the closure.
/**
 * @type {InternalBinding}
 */
let internalBinding;
{
  const bindingObj = { __proto__: null };
  // eslint-disable-next-line no-global-assign
  internalBinding = function internalBinding(module) {
    let mod = bindingObj[module];
    if (typeof mod !== 'object') {
      mod = bindingObj[module] = getInternalBinding(module);
      ArrayPrototypePush(moduleLoadList, `Internal Binding ${module}`);
    }
    return mod;
  };
}

const selfId = 'internal/bootstrap/realm';
const {
  builtinIds,
  compileFunction,
  setInternalLoaders,
} = internalBinding('builtins');

const getOwn = (target, property, receiver) => {
  return ObjectPrototypeHasOwnProperty(target, property) ?
    ReflectGet(target, property, receiver) :
    undefined;
};

const publicBuiltinIds = builtinIds
  .filter((id) =>
    !StringPrototypeStartsWith(id, 'internal/') &&
      !experimentalModuleList.has(id),
  );
// Do not expose the loaders to user land even with --expose-internals.
const internalBuiltinIds = builtinIds
  .filter((id) => StringPrototypeStartsWith(id, 'internal/') && id !== selfId);

// When --expose-internals is on we'll add the internal builtin ids to these.
const canBeRequiredByUsersList = new SafeSet(publicBuiltinIds);
const canBeRequiredByUsersWithoutSchemeList =
  new SafeSet(publicBuiltinIds.filter((id) => !schemelessBlockList.has(id)));

/**
 * An internal abstraction for the built-in JavaScript modules of Node.js.
 * Be careful not to expose this to user land unless --expose-internals is
 * used, in which case there is no compatibility guarantee about this class.
 */
class BuiltinModule {
  /**
   * A map from the module IDs to the module instances.
   * @type {Map<string, BuiltinModule>}
   */
  static map = new SafeMap(
    ArrayPrototypeMap(builtinIds, (id) => [id, new BuiltinModule(id)]),
  );

  constructor(id) {
    this.filename = `${id}.js`;
    this.id = id;

    // The CJS exports object of the module.
    this.exports = {};
    // States used to work around circular dependencies.
    this.loaded = false;
    this.loading = false;

    // The following properties are used by the ESM implementation and only
    // initialized when the built-in module is loaded by users.
    /**
     * The C++ ModuleWrap binding used to interface with the ESM implementation.
     * @type {ModuleWrap|undefined}
     */
    this.module = undefined;
    /**
     * Exported names for the ESM imports.
     * @type {string[]|undefined}
     */
    this.exportKeys = undefined;
  }

  static allowRequireByUsers(id) {
    if (id === selfId) {
      // No code because this is an assertion against bugs.
      // eslint-disable-next-line no-restricted-syntax
      throw new Error(`Should not allow ${id}`);
    }
    canBeRequiredByUsersList.add(id);
    if (!schemelessBlockList.has(id)) {
      canBeRequiredByUsersWithoutSchemeList.add(id);
    }
  }

  // To be called during pre-execution when --expose-internals is on.
  // Enables the user-land module loader to access internal modules.
  static exposeInternals() {
    for (let i = 0; i < internalBuiltinIds.length; ++i) {
      BuiltinModule.allowRequireByUsers(internalBuiltinIds[i]);
    }
  }

  static exists(id) {
    return BuiltinModule.map.has(id);
  }

  static canBeRequiredByUsers(id) {
    return canBeRequiredByUsersList.has(id);
  }

  static canBeRequiredWithoutScheme(id) {
    return canBeRequiredByUsersWithoutSchemeList.has(id);
  }

  static isBuiltin(id) {
    return BuiltinModule.canBeRequiredWithoutScheme(id) || (
      typeof id === 'string' &&
        StringPrototypeStartsWith(id, 'node:') &&
        BuiltinModule.canBeRequiredByUsers(StringPrototypeSlice(id, 5))
    );
  }

  static getCanBeRequiredByUsersWithoutSchemeList() {
    return ArrayFrom(canBeRequiredByUsersWithoutSchemeList);
  }

  static getSchemeOnlyModuleNames() {
    return ArrayFrom(schemelessBlockList);
  }

  // Used by user-land module loaders to compile and load builtins.
  compileForPublicLoader() {
    if (!BuiltinModule.canBeRequiredByUsers(this.id)) {
      // No code because this is an assertion against bugs
      // eslint-disable-next-line no-restricted-syntax
      throw new Error(`Should not compile ${this.id} for public use`);
    }
    this.compileForInternalLoader();
    if (!this.exportKeys) {
      // When using --expose-internals, we do not want to reflect the named
      // exports from core modules as this can trigger unnecessary getters.
      const internal = StringPrototypeStartsWith(this.id, 'internal/');
      this.exportKeys = internal ? [] : ObjectKeys(this.exports);
    }
    this.getESMFacade();
    this.syncExports();
    return this.exports;
  }

  getESMFacade() {
    if (this.module) return this.module;
    const { ModuleWrap } = internalBinding('module_wrap');
    // TODO(aduh95): move this to C++, alongside the initialization of the class.
    ObjectSetPrototypeOf(ModuleWrap.prototype, null);
    const url = `node:${this.id}`;
    const builtin = this;
    const exportsKeys = ArrayPrototypeSlice(this.exportKeys);
    ArrayPrototypePush(exportsKeys, 'default');
    this.module = new ModuleWrap(
      url, undefined, exportsKeys,
      function() {
        builtin.syncExports();
        this.setExport('default', builtin.exports);
      });
    // Ensure immediate sync execution to capture exports now
    this.module.instantiate();
    this.module.evaluate(-1, false);
    return this.module;
  }

  // Provide named exports for all builtin libraries so that the libraries
  // may be imported in a nicer way for ESM users. The default export is left
  // as the entire namespace (module.exports) and updates when this function is
  // called so that APMs and other behavior are supported.
  syncExports() {
    const names = this.exportKeys;
    if (this.module) {
      for (let i = 0; i < names.length; i++) {
        const exportName = names[i];
        if (exportName === 'default') continue;
        this.module.setExport(exportName,
                              getOwn(this.exports, exportName, this.exports));
      }
    }
  }

  compileForInternalLoader() {
    if (this.loaded || this.loading) {
      return this.exports;
    }

    const id = this.id;
    this.loading = true;

    try {
      const requireFn = StringPrototypeStartsWith(this.id, 'internal/deps/') ?
        requireWithFallbackInDeps : requireBuiltin;

      const fn = compileFunction(id);
      // Arguments must match the parameters specified in
      // BuiltinLoader::LookupAndCompile().
      fn(this.exports, requireFn, this, process, internalBinding, primordials);

      this.loaded = true;
    } finally {
      this.loading = false;
    }

    // "NativeModule" is a legacy name of "BuiltinModule". We keep it
    // here to avoid breaking users who parse process.moduleLoadList.
    ArrayPrototypePush(moduleLoadList, `NativeModule ${id}`);
    return this.exports;
  }
}

// Think of this as module.exports in this file even though it is not
// written in CommonJS style.
const loaderExports = {
  internalBinding,
  BuiltinModule,
  require: requireBuiltin,
};

function requireBuiltin(id) {
  if (id === selfId) {
    return loaderExports;
  }

  const mod = BuiltinModule.map.get(id);
  // Can't load the internal errors module from here, have to use a raw error.
  // eslint-disable-next-line no-restricted-syntax
  if (!mod) throw new TypeError(`Missing internal module '${id}'`);
  return mod.compileForInternalLoader();
}

// Allow internal modules from dependencies to require
// other modules from dependencies by providing fallbacks.
function requireWithFallbackInDeps(request) {
  if (!BuiltinModule.map.has(request)) {
    request = `internal/deps/${request}`;
  }
  return requireBuiltin(request);
}

function setupPrepareStackTrace() {
  const {
    setEnhanceStackForFatalException,
    setPrepareStackTraceCallback,
  } = internalBinding('errors');
  const {
    prepareStackTrace,
    fatalExceptionStackEnhancers: {
      beforeInspector,
      afterInspector,
    },
  } = requireBuiltin('internal/errors');
  // Tell our PrepareStackTraceCallback passed to the V8 API
  // to call prepareStackTrace().
  setPrepareStackTraceCallback(prepareStackTrace);
  // Set the function used to enhance the error stack for printing
  setEnhanceStackForFatalException(beforeInspector, afterInspector);
}

// Store the internal loaders in C++.
setInternalLoaders(internalBinding, requireBuiltin);

// Setup per-realm bindings.
setupPrepareStackTrace();