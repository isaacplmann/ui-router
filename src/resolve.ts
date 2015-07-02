/// <reference path='../bower_components/DefinitelyTyped/angularjs/angular.d.ts' />

import {isDefined, isObject, isString, extend, forEach, isArray, noop} from "./common";
import {defaults, pick, map, merge, tpl, filter, omit, parse, pluck, find, pipe, prop, eq}  from "./common";
import {trace}  from "./trace";
import {IPromise, IQService, identity} from "angular";
import {IPublicState} from "./state";

var $injector: ng.auto.IInjectorService, $q: IQService;

/**
 * The basic building block for the resolve system.
 *
 * Resolvables encapsulate a state's resolve's resolveFn, the resolveFn's declared dependencies, the wrapped (.promise),
 * and the unwrapped-when-complete (.data) result of the resolveFn.
 *
 * Resolvable.get() either retrieves the Resolvable's existing promise, or else invokes resolve() (which invokes the
 * resolveFn) and returns the resulting promise.
 *
 * Resolvable.get() and Resolvable.resolve() both execute within a context Path, which is passed as the first
 * parameter to those fns.
 */
export class Resolvable {
  constructor(name: string, resolveFn: Function, state: IPublicState) {
    this.name = name;
    this.resolveFn = resolveFn;
    this.state = state;
    this.deps = $injector.annotate(resolveFn);
  }

  name: String;
  resolveFn: Function;
  state: IPublicState;
  deps: string[];

  promise: IPromise<any> = undefined;
  data: any;

  // synchronous part:
  // - sets up the Resolvable's promise
  // - retrieves dependencies' promises
  // - returns promise for async part

  // asynchronous part:
  // - wait for dependencies promises to resolve
  // - invoke the resolveFn
  // - wait for resolveFn promise to resolve
  // - store unwrapped data
  // - resolve the Resolvable's promise
  resolveResolvable(pathContext, options) {
    options = options || {};
    if (options.trace) trace.traceResolveResolvable(this, options);
    // First, set up an overall deferred/promise for this Resolvable
    var deferred = $q.defer();
    this.promise = deferred.promise;

    // Load a map of all resolvables for this state from the context path
    // Omit the current Resolvable from the result, so we don't try to inject this into this
    var ancestorsByName = pathContext.getResolvables({  omitOwnLocals: [ this.name ] });

    // Limit the ancestors Resolvables map to only those that the current Resolvable fn's annotations depends on
    var depResolvables = pick(ancestorsByName, this.deps);

    // Get promises (or synchronously invoke resolveFn) for deps
    var depPromises: any = map(depResolvables, function(resolvable) {
      return resolvable.get(pathContext);
    });

    // Return a promise chain that waits for all the deps to resolve, then invokes the resolveFn passing in the
    // dependencies as locals, then unwraps the resulting promise's data.
    return $q.all(depPromises).then(locals => {
      try {
        var result = $injector.invoke(this.resolveFn, this.state, locals);
        deferred.resolve(result);
      } catch (error) {
        deferred.reject(error);
      }
      return this.promise;
    }).then(function(data) {
      this.data = data;
      return this.promise;
    });
  }

  get(pathContext, options): IPromise<any> {
    return this.promise || this.resolveResolvable(pathContext, options);
  }

  // TODO: nuke this in favor of resolveResolvable
  resolve(pathContext, options) { return this.resolveResolvable(pathContext, options); }

  toString() {
    return tpl("Resolvable(name: {name}, state: {state.name}, requires: [{deps}])", this);
  }
}


// Eager resolves are resolved before the transition starts.
// Lazy resolves are resolved before their state is entered.
// JIT resolves are resolved just-in-time, right before an injected function that depends on them is invoked.
var resolvePolicies = { eager: 3, lazy: 2, jit: 1 };
var defaultResolvePolicy = "jit"; // TODO: make this configurable

/**
 * An element in the path which represents a state and that state's Resolvables and their resolve statuses.
 * When the resolved data is ready, it is stored in each Resolvable object within the PathElement
 *
 * Should be passed a state object.  I think maybe state could even be the public state, so users can add resolves
 * on the fly.
 */
export class PathElement {
  constructor(state: IPublicState) {
    this.state = state;
    // Convert state's resolvable assoc-array into an assoc-array of empty Resolvable(s)
    this._resolvables = map(state.resolve || {}, function(resolveFn, resolveName) {
      return new Resolvable(resolveName, resolveFn, state);
    });
  }

  state: IPublicState;
  private _resolvables: Object;

  getResolvables(): Object {
    return this._resolvables;
  }

  addResolvables(resolvablesByName): Object {
    return extend(this._resolvables, resolvablesByName);
  }

  // returns a promise for all resolvables on this PathElement
  // options.policy: only return promises for those Resolvables which are at the specified policy strictness, or above.
  resolvePathElement(pathContext, options): IPromise<any> {
    options = options || {};
    var policyOrdinal = resolvePolicies[options && options.policy || defaultResolvePolicy];

    var policyConf = {
      $$state: isString(this.state.resolvePolicy) ? this.state.resolvePolicy : defaultResolvePolicy,
      $$resolves: isObject(this.state.resolvePolicy) ? this.state.resolvePolicy : defaultResolvePolicy
    };

    // Isolate only this element's resolvables
    var elements: PathElement[] = [this];
    var resolvables = <any> (new Path(elements).getResolvables());
    forEach(resolvables, function(resolvable) {
      var policyString = policyConf.$$resolves[resolvable.name] || policyConf.$$state;
      policyConf[resolvable.name] = resolvePolicies[policyString];
    });

    const matchesPolicy = (resolvable) => policyConf[resolvable.name] >= policyOrdinal;
    const getResolvePromise = (resolvable) => resolvable.get(pathContext, options);

    if (options.trace) trace.traceResolvePathElement(this, filter(resolvables, matchesPolicy), options);
    var resolvablePromises = map(filter(resolvables, matchesPolicy), getResolvePromise);
    return $q.all(resolvablePromises).then(noop);
  }

  // Injects a function at this PathElement level with available Resolvables
  // First it resolves all resolvables.  When they are done resolving, invokes the function.
  // Returns a promise for the return value of the function.
  // public function
  // fn is the function to inject (onEnter, onExit, controller)
  // locals are the regular-style locals to inject
  // pathContext is a Path which is used to retrieve dependent Resolvables for injecting
  invokeLater(fn, locals, pathContext, options): IPromise<any> {
    options = options || {};
    var deps = $injector.annotate(fn);
    var resolvables = pick(pathContext.pathFromRoot(this).getResolvables(), deps);
    if (options.trace) trace.tracePathElementInvoke(this, fn, deps, extend({ when: "Later"}, options));

    var promises: any = map(resolvables, function(resolvable) { return resolvable.get(pathContext); });
    return $q.all(promises).then(() => {
      try {
        return this.invokeNow(fn, locals, pathContext, options);
      } catch (error) {
        return $q.reject(error);
      }
    });
  }

  // private function? Maybe needs to be public-to-$transition to allow onEnter/onExit to be invoked synchronously
  // and in the correct order, but only after we've manually ensured all the deps are resolved.

  // Injects a function at this PathElement level with available Resolvables
  // Does not wait until all Resolvables have been resolved; you must call PathElement.resolve() (or manually resolve each dep) first
  invokeNow(fn, locals, pathContext, options) {
    options = options || {};
    var deps = $injector.annotate(fn);
    var resolvables = pick(pathContext.pathFromRoot(this).getResolvables(), deps);
    if (options.trace) trace.tracePathElementInvoke(this, fn, $injector.annotate(fn), extend({ when: "Now  "}, options));

    var moreLocals = map(resolvables, function(resolvable) { return resolvable.data; });
    var combinedLocals = extend({}, locals, moreLocals);
    return $injector.invoke(fn, this.state, combinedLocals);
  }

  toString(): string {
    var tplData = { state: parse("state.name")(this) || "(root)" };
    return tpl("PathElement({state})", tplData);
  }
}


/**
 *  A Path Object holds an ordered list of PathElements.
 *
 *  This object is used to store resolve status for an entire path of states. It has concat and slice
 *  helper methods to return new Paths, based on the current Path.
 *
 *
 *  Path becomes the replacement data structure for $state.$current.locals.
 *  The Path is used in the three resolve() functions (Path.resolvePath, PathElement.resolvePathElement,
 *  and Resolvable.resolveResolvable) and provides context for injectable dependencies (Resolvables)
 *
 *  @param statesOrPathElements [array]: an array of either state(s) or PathElement(s)
 */

export class Path {
  constructor(statesOrPathElements: (IPublicState[] | PathElement[])) {
    if (!isArray(statesOrPathElements))
      throw new Error("states must be an array of state(s) or PathElement(s): ${statesOrPathElements}");

    var isPathElementArray = (statesOrPathElements.length && (statesOrPathElements[0] instanceof PathElement));
    var toPathElement = isPathElementArray ? identity : function (state) { return new PathElement(state); };
    this.elements = <PathElement[]> map(statesOrPathElements, toPathElement);
  }

  elements: PathElement[];

  // Returns a promise for an array of resolved Path Element promises
  resolvePath(options: any): IPromise<any> {
    options = options || {};
    if (options.trace) trace.traceResolvePath(this, options);
    const elementPromises = (element => element.resolvePathElement(this, options));
    return $q.all(<any> map(this.elements, elementPromises)).then(noop);
  }
  // TODO nuke this in favor of resolvePath()
  resolve(options: any) { return this.resolvePath(options); }

  /**
   *  Gets the available Resolvables for the last element of this path.
   *
   * @param options
   *
   * options.omitOwnLocals: array of property names
   *   Omits those Resolvables which are found on the last element of the path.
   *
   *   This will hide a deepest-level resolvable (by name), potentially exposing a parent resolvable of
   *   the same name further up the state tree.
   *
   *   This is used by Resolvable.resolve() in order to provide the Resolvable access to all the other
   *   Resolvables at its own PathElement level, yet disallow that Resolvable access to its own injectable Resolvable.
   *
   *   This is also used to allow a state to override a parent state's resolve while also injecting
   *   that parent state's resolve:
   *
   *   state({ name: 'G', resolve: { _G: function() { return "G"; } } });
   *   state({ name: 'G.G2', resolve: { _G: function(_G) { return _G + "G2"; } } });
   *   where injecting _G into a controller will yield "GG2"
   */
  getResolvables(options?: any): { [key:string]:Resolvable; } {
    options = defaults(options, { omitOwnLocals: [] });
    var last = this.last();
    return this.elements.reduce(function(memo, elem) {
      var omitProps = (elem === last) ? options.omitOwnLocals : [];
      var elemResolvables = omit.apply(null, [elem.getResolvables()].concat(omitProps));
      return extend(memo, elemResolvables);
    }, {});
  }

  clone(): Path {
    throw new Error("Clone not yet implemented");
  }

  // returns a subpath of this path from the root path element up to and including the toPathElement parameter
  pathFromRoot(toPathElement): Path {
    var elementIdx = this.elements.indexOf(toPathElement);
    if (elementIdx == -1) throw new Error("This Path does not contain the toPathElement");
    return this.slice(0, elementIdx + 1);
  }

  concat(path): Path {
    return new Path(this.elements.concat(path.elements));
  }

  slice(start: number, end?: number): Path {
    return new Path(this.elements.slice(start, end));
  }

  reverse(): Path {
    this.elements.reverse(); // TODO: return new Path()
    return this;
  }

  states(): IPublicState[] {
    return pluck(this.elements, "state");
  }

  elementForState(state: IPublicState) {
    return find(this.elements, pipe(prop('state'), eq(state)));
  }

  last(): PathElement {
    return this.elements.length ? this.elements[this.elements.length - 1] : null;
  }

  toString() {
    var tplData = { elements: this.elements.map(function(e) { return e.state.name; }).join(", ") };
    return tpl("Path([{elements}])", tplData);
  }
}

run.$inject = ['$q',    '$injector'];
function run(  _$q_,    _$injector_) {
  $q = _$q_;
  $injector = _$injector_;
}


/**
 * @ngdoc object
 * @name ui.router.util.$resolve
 *
 * @requires $q
 * @requires $injector
 *
 * @description
 * Manages resolution of (acyclic) graphs of promises.
 */
$Resolve.$inject = ['$q', '$injector'];
function $Resolve(  $q,    $injector) {

  // ----------------- 0.2.xx Legacy API here ------------------------
  var VISIT_IN_PROGRESS = 1,
      VISIT_DONE = 2,
      NOTHING = {},
      NO_DEPENDENCIES = [],
      NO_LOCALS = NOTHING,
      NO_PARENT = extend($q.when(NOTHING), { $$promises: NOTHING, $$values: NOTHING });


  /**
   * @ngdoc function
   * @name ui.router.util.$resolve#study
   * @methodOf ui.router.util.$resolve
   *
   * @description
   * Studies a set of invocables that are likely to be used multiple times.
   * <pre>
   * $resolve.study(invocables)(locals, parent, self)
   * </pre>
   * is equivalent to
   * <pre>
   * $resolve.resolve(invocables, locals, parent, self)
   * </pre>
   * but the former is more efficient (in fact `resolve` just calls `study`
   * internally).
   *
   * @param {object} invocables Invocable objects
   * @return {function} a function to pass in locals, parent and self
   */
  this.study = function (invocables) {
    if (!isObject(invocables)) throw new Error("'invocables' must be an object");
    var invocableKeys = Object.keys(invocables || {});

    // Perform a topological sort of invocables to build an ordered plan
    var plan = [], cycle = [], visited = {};

    function visit(value, key) {

      if (visited[key] === VISIT_DONE) return;

      cycle.push(key);

      if (visited[key] === VISIT_IN_PROGRESS) {
        cycle.splice(0, cycle.indexOf(key));
        throw new Error("Cyclic dependency: " + cycle.join(" -> "));
      }
      visited[key] = VISIT_IN_PROGRESS;

      if (isString(value)) {
        plan.push(key, [ function() { return $injector.get(value); }], NO_DEPENDENCIES);
      } else {
        var params = $injector.annotate(value);
        forEach(params, function (param) {
          if (param !== key && invocables.hasOwnProperty(param)) visit(invocables[param], param);
        });
        plan.push(key, value, params);
      }

      cycle.pop();
      visited[key] = VISIT_DONE;
    }

    forEach(invocables, visit);
    invocables = cycle = visited = null; // plan is all that's required

    function isResolve(value) {
      return isObject(value) && value.then && value.$$promises;
    }

    return function (locals, parent, self) {
      if (isResolve(locals) && self === undefined) {
        self = parent; parent = locals; locals = null;
      }
      if (!locals) locals = NO_LOCALS;
      else if (!isObject(locals)) throw new Error("'locals' must be an object");

      if (!parent) parent = NO_PARENT;
      else if (!isResolve(parent)) throw new Error("'parent' must be a promise returned by $resolve.resolve()");

      // To complete the overall resolution, we have to wait for the parent
      // promise and for the promise for each invokable in our plan.
      var resolution = $q.defer(),
          result = resolution.promise,
          promises = result.$$promises = {},
          values = extend({}, locals),
          wait = 1 + plan.length / 3,
          merged = false;

      function done() {
        // Merge parent values we haven't got yet and publish our own $$values
        if (!--wait) {
          if (!merged) merge(values, parent.$$values);
          result.$$values = values;
          result.$$promises = result.$$promises || true; // keep for isResolve()
          delete result.$$inheritedValues;
          resolution.resolve(values);
        }
      }

      function fail(reason) {
        result.$$failure = reason;
        resolution.reject(reason);
      }

      // Short-circuit if parent has already failed
      if (isDefined(parent.$$failure)) {
        fail(parent.$$failure);
        return result;
      }

      if (parent.$$inheritedValues) {
        merge(values, omit(parent.$$inheritedValues, invocableKeys));
      }

      // Merge parent values if the parent has already resolved, or merge
      // parent promises and wait if the parent resolve is still in progress.
      extend(promises, parent.$$promises);
      if (parent.$$values) {
        merged = merge(values, omit(parent.$$values, invocableKeys));
        result.$$inheritedValues = omit(parent.$$values, invocableKeys);
        done();
      } else {
        if (parent.$$inheritedValues) {
          result.$$inheritedValues = omit(parent.$$inheritedValues, invocableKeys);
        }
        parent.then(done, fail);
      }

      // Process each invocable in the plan, but ignore any where a local of the same name exists.
      for (var i = 0, ii = plan.length; i < ii; i += 3) {
        if (locals.hasOwnProperty(plan[i])) done();
        else __invoke(plan[i], plan[i + 1], plan[i + 2]);
      }

      function __invoke(key, invocable, params) {
        // Create a deferred for this invocation. Failures will propagate to the resolution as well.
        var invocation = $q.defer(), waitParams = 0;
        function onfailure(reason) {
          invocation.reject(reason);
          fail(reason);
        }
        // Wait for any parameter that we have a promise for (either from parent or from this
        // resolve; in that case study() will have made sure it's ordered before us in the plan).
        forEach(params, function (dep) {
          if (promises.hasOwnProperty(dep) && !locals.hasOwnProperty(dep)) {
            waitParams++;
            promises[dep].then(function (result) {
              values[dep] = result;
              if (!(--waitParams)) proceed();
            }, onfailure);
          }
        });
        if (!waitParams) proceed();
        function proceed() {
          if (isDefined(result.$$failure)) return;
          try {
            invocation.resolve($injector.invoke(invocable, self, values));
            invocation.promise.then(function (result) {
              values[key] = result;
              done();
            }, onfailure);
          } catch (e) {
            onfailure(e);
          }
        }
        // Publish promise synchronously; invocations further down in the plan may depend on it.
        promises[key] = invocation.promise;
      }

      return result;
    };
  };

  /**
   * @ngdoc function
   * @name ui.router.util.$resolve#resolve
   * @methodOf ui.router.util.$resolve
   *
   * @description
   * Resolves a set of invocables. An invocable is a function to be invoked via
   * `$injector.invoke()`, and can have an arbitrary number of dependencies.
   * An invocable can either return a value directly,
   * or a `$q` promise. If a promise is returned it will be resolved and the
   * resulting value will be used instead. Dependencies of invocables are resolved
   * (in this order of precedence)
   *
   * - from the specified `locals`
   * - from another invocable that is part of this `$resolve` call
   * - from an invocable that is inherited from a `parent` call to `$resolve`
   *   (or recursively
   * - from any ancestor `$resolve` of that parent).
   *
   * The return value of `$resolve` is a promise for an object that contains
   * (in this order of precedence)
   *
   * - any `locals` (if specified)
   * - the resolved return values of all injectables
   * - any values inherited from a `parent` call to `$resolve` (if specified)
   *
   * The promise will resolve after the `parent` promise (if any) and all promises
   * returned by injectables have been resolved. If any invocable
   * (or `$injector.invoke`) throws an exception, or if a promise returned by an
   * invocable is rejected, the `$resolve` promise is immediately rejected with the
   * same error. A rejection of a `parent` promise (if specified) will likewise be
   * propagated immediately. Once the `$resolve` promise has been rejected, no
   * further invocables will be called.
   *
   * Cyclic dependencies between invocables are not permitted and will caues `$resolve`
   * to throw an error. As a special case, an injectable can depend on a parameter
   * with the same name as the injectable, which will be fulfilled from the `parent`
   * injectable of the same name. This allows inherited values to be decorated.
   * Note that in this case any other injectable in the same `$resolve` with the same
   * dependency would see the decorated value, not the inherited value.
   *
   * Note that missing dependencies -- unlike cyclic dependencies -- will cause an
   * (asynchronous) rejection of the `$resolve` promise rather than a (synchronous)
   * exception.
   *
   * Invocables are invoked eagerly as soon as all dependencies are available.
   * This is true even for dependencies inherited from a `parent` call to `$resolve`.
   *
   * As a special case, an invocable can be a string, in which case it is taken to
   * be a service name to be passed to `$injector.get()`. This is supported primarily
   * for backwards-compatibility with the `resolve` property of `$routeProvider`
   * routes.
   *
   * @param {object} invocables functions to invoke or
   * `$injector` services to fetch.
   * @param {object} locals  values to make available to the injectables
   * @param {object} parent  a promise returned by another call to `$resolve`.
   * @param {object} self  the `this` for the invoked methods
   * @return {object} Promise for an object that contains the resolved return value
   * of all invocables, as well as any inherited and local values.
   */
  this.resolve = function (invocables, locals, parent, self) {
    return this.study(invocables)(locals, parent, self);
  };
}

angular.module('ui.router.util').service('$resolve', $Resolve).run(run);