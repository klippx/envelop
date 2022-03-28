import {
  AfterParseHook,
  AfterValidateHook,
  ArbitraryObject,
  EnvelopContextFnWrapper,
  GetEnvelopedFn,
  OnContextBuildingHook,
  AfterContextBuildingHook,
  OnEnvelopedHook,
  OnExecuteDoneHook,
  OnExecuteHook,
  OnParseHook,
  OnResolverCalledHook,
  OnSubscribeHook,
  OnValidateHook,
  Plugin,
  SubscribeResultHook,
  TypedSubscriptionArgs,
  TypedExecutionArgs,
  SubscribeFunction,
  OnSubscribeResultResultOnNextHook,
  OnSubscribeResultResultOnEndHook,
  OnExecuteDoneHookResultOnNextHook,
  OnExecuteDoneHookResultOnEndHook,
  ExecuteFunction,
  AsyncIterableIteratorOrValue,
  OnContextErrorHandler,
  SubscribeErrorHook,
  DefaultContext,
  Maybe,
} from '@envelop/types';
import {
  DocumentNode,
  execute,
  ExecutionResult,
  GraphQLError,
  GraphQLSchema,
  parse,
  specifiedRules,
  subscribe,
  validate,
  ValidationRule,
} from 'graphql';
import { prepareTracedSchema, resolversHooksSymbol } from './traced-schema';
import { errorAsyncIterator, finalAsyncIterator, makeExecute, makeSubscribe, mapAsyncIterator, isAsyncIterable } from './utils';

export type EnvelopOrchestrator<
  InitialContext extends ArbitraryObject = ArbitraryObject,
  PluginsContext extends ArbitraryObject = ArbitraryObject
> = {
  init: (initialContext?: Maybe<InitialContext>) => void;
  parse: EnvelopContextFnWrapper<ReturnType<GetEnvelopedFn<PluginsContext>>['parse'], InitialContext>;
  validate: EnvelopContextFnWrapper<ReturnType<GetEnvelopedFn<PluginsContext>>['validate'], InitialContext>;
  execute: ReturnType<GetEnvelopedFn<PluginsContext>>['execute'];
  subscribe: ReturnType<GetEnvelopedFn<PluginsContext>>['subscribe'];
  contextFactory: EnvelopContextFnWrapper<ReturnType<GetEnvelopedFn<PluginsContext>>['contextFactory'], PluginsContext>;
  getCurrentSchema: () => Maybe<GraphQLSchema>;
};

export function createEnvelopOrchestrator<PluginsContext extends DefaultContext>(
  plugins: Plugin[]
): EnvelopOrchestrator<any, PluginsContext> {
  let schema: GraphQLSchema | undefined | null = null;
  let initDone = false;
  const onResolversHandlers: OnResolverCalledHook[] = [];
  for (const plugin of plugins) {
    if (plugin.onResolverCalled) {
      onResolversHandlers.push(plugin.onResolverCalled);
    }
  }

  // Define the initial method for replacing the GraphQL schema, this is needed in order
  // to allow setting the schema from the onPluginInit callback. We also need to make sure
  // here not to call the same plugin that initiated the schema switch.
  const replaceSchema = (newSchema: GraphQLSchema, ignorePluginIndex = -1) => {
    if (onResolversHandlers.length) {
      prepareTracedSchema(newSchema);
    }
    schema = newSchema;

    if (initDone) {
      for (const [i, plugin] of plugins.entries()) {
        if (i !== ignorePluginIndex) {
          plugin.onSchemaChange &&
            plugin.onSchemaChange({
              schema,
              replaceSchema: schemaToSet => {
                replaceSchema(schemaToSet, i);
              },
            });
        }
      }
    }
  };

  const contextErrorHandlers: Array<OnContextErrorHandler> = [];

  // Iterate all plugins and trigger onPluginInit
  for (const [i, plugin] of plugins.entries()) {
    plugin.onPluginInit &&
      plugin.onPluginInit({
        plugins,
        addPlugin: newPlugin => {
          plugins.push(newPlugin);
        },
        setSchema: modifiedSchema => replaceSchema(modifiedSchema, i),
        registerContextErrorHandler: handler => contextErrorHandlers.push(handler),
      });
  }

  // A set of before callbacks defined here in order to allow it to be used later
  const beforeCallbacks = {
    init: [] as OnEnvelopedHook<any>[],
    parse: [] as OnParseHook<any>[],
    validate: [] as OnValidateHook<any>[],
    subscribe: [] as OnSubscribeHook<any>[],
    execute: [] as OnExecuteHook<any>[],
    context: [] as OnContextBuildingHook<any>[],
  };

  for (const { onContextBuilding, onExecute, onParse, onSubscribe, onValidate, onEnveloped } of plugins) {
    onEnveloped && beforeCallbacks.init.push(onEnveloped);
    onContextBuilding && beforeCallbacks.context.push(onContextBuilding);
    onExecute && beforeCallbacks.execute.push(onExecute);
    onParse && beforeCallbacks.parse.push(onParse);
    onSubscribe && beforeCallbacks.subscribe.push(onSubscribe);
    onValidate && beforeCallbacks.validate.push(onValidate);
  }

  const init: EnvelopOrchestrator['init'] = initialContext => {
    for (const [i, onEnveloped] of beforeCallbacks.init.entries()) {
      onEnveloped({
        context: initialContext,
        extendContext: extension => {
          if (!initialContext) {
            return;
          }

          Object.assign(initialContext, extension);
        },
        setSchema: modifiedSchema => replaceSchema(modifiedSchema, i),
      });
    }
  };

  const customParse: EnvelopContextFnWrapper<typeof parse, any> = beforeCallbacks.parse.length
    ? initialContext => (source, parseOptions) => {
        let result: DocumentNode | GraphQLError | null = null;
        let parseFn: typeof parse = parse;
        const context = initialContext;
        const afterCalls: AfterParseHook<any>[] = [];

        for (const onParse of beforeCallbacks.parse) {
          const afterFn = onParse({
            context,
            extendContext: extension => {
              Object.assign(context, extension);
            },
            params: { source, options: parseOptions },
            parseFn,
            setParseFn: newFn => {
              parseFn = newFn;
            },
            setParsedDocument: newDoc => {
              result = newDoc;
            },
          });

          afterFn && afterCalls.push(afterFn);
        }

        if (result === null) {
          try {
            result = parseFn(source, parseOptions);
          } catch (e) {
            result = e as GraphQLError;
          }
        }

        for (const afterCb of afterCalls) {
          afterCb({
            context,
            extendContext: extension => {
              Object.assign(context, extension);
            },
            replaceParseResult: newResult => {
              result = newResult;
            },
            result,
          });
        }

        if (result === null) {
          throw new Error(`Failed to parse document.`);
        }

        if (result instanceof Error) {
          throw result;
        }

        return result;
      }
    : () => parse;

  const customValidate: EnvelopContextFnWrapper<typeof validate, any> = beforeCallbacks.validate.length
    ? initialContext => (schema, documentAST, rules, typeInfo, validationOptions) => {
        let actualRules: undefined | ValidationRule[] = rules ? [...rules] : undefined;
        let validateFn = validate;
        let result: null | readonly GraphQLError[] = null;
        const context = initialContext;

        const afterCalls: AfterValidateHook<any>[] = [];

        for (const onValidate of beforeCallbacks.validate) {
          const afterFn = onValidate({
            context,
            extendContext: extension => {
              Object.assign(context, extension);
            },
            params: {
              schema,
              documentAST,
              rules: actualRules,
              typeInfo,
              options: validationOptions,
            },
            validateFn,
            addValidationRule: rule => {
              if (!actualRules) {
                actualRules = [...specifiedRules];
              }

              actualRules.push(rule);
            },
            setValidationFn: newFn => {
              validateFn = newFn;
            },
            setResult: newResults => {
              result = newResults;
            },
          });

          afterFn && afterCalls.push(afterFn);
        }

        if (!result) {
          result = validateFn(schema, documentAST, actualRules, typeInfo, validationOptions);
        }

        const valid = result.length === 0;

        for (const afterCb of afterCalls) {
          afterCb({
            valid,
            result,
            context,
            extendContext: extension => {
              Object.assign(context, extension);
            },
          });
        }

        return result;
      }
    : () => validate;

  const customContextFactory: EnvelopContextFnWrapper<(orchestratorCtx?: any) => any, any> = beforeCallbacks.context.length
    ? initialContext => async orchestratorCtx => {
        const afterCalls: AfterContextBuildingHook<any>[] = [];

        try {
          let context = orchestratorCtx ? { ...initialContext, ...orchestratorCtx } : initialContext;
          let isBreakingContextBuilding = false;

          for (const onContext of beforeCallbacks.context) {
            const afterHookResult = await onContext({
              context,
              extendContext: extension => {
                context = { ...context, ...extension };
              },
              breakContextBuilding: () => {
                isBreakingContextBuilding = true;
              },
            });

            if (typeof afterHookResult === 'function') {
              afterCalls.push(afterHookResult);
            }

            if ((isBreakingContextBuilding as boolean) === true) {
              break;
            }
          }

          for (const afterCb of afterCalls) {
            afterCb({
              context,
              extendContext: extension => {
                context = { ...context, ...extension };
              },
            });
          }

          return context;
        } catch (err) {
          let error: unknown = err;
          for (const errorCb of contextErrorHandlers) {
            errorCb({
              error,
              setError: err => {
                error = err;
              },
            });
          }
          throw error;
        }
      }
    : initialContext => orchestratorCtx => orchestratorCtx ? { ...initialContext, ...orchestratorCtx } : initialContext;

  const useCustomSubscribe = beforeCallbacks.subscribe.length || onResolversHandlers.length;

  const customSubscribe = useCustomSubscribe
    ? makeSubscribe(async args => {
        let subscribeFn = subscribe as SubscribeFunction;

        const afterCalls: SubscribeResultHook<PluginsContext>[] = [];
        const subscribeErrorHandlers: SubscribeErrorHook[] = [];

        let context = (args.contextValue as {}) || {};
        let result: AsyncIterableIteratorOrValue<ExecutionResult> | undefined;

        for (const onSubscribe of beforeCallbacks.subscribe) {
          const after = await onSubscribe({
            subscribeFn,
            setSubscribeFn: newSubscribeFn => {
              subscribeFn = newSubscribeFn;
            },
            extendContext: extension => {
              context = { ...context, ...extension };
            },
            args: args as TypedSubscriptionArgs<PluginsContext>,
            setResultAndStopExecution: stopResult => {
              result = stopResult;
            },
          });

          if (after) {
            if (after.onSubscribeResult) {
              afterCalls.push(after.onSubscribeResult);
            }
            if (after.onSubscribeError) {
              subscribeErrorHandlers.push(after.onSubscribeError);
            }
          }

          if (result !== undefined) {
            break;
          }
        }

        if (onResolversHandlers.length) {
          context[resolversHooksSymbol] = onResolversHandlers;
        }

        if (result === undefined) {
          result = await subscribeFn({
            ...args,
            contextValue: context,
            // Casted for GraphQL.js 15 compatibility
            // Can be removed once we drop support for GraphQL.js 15
          });
        }

        const onNextHandler: OnSubscribeResultResultOnNextHook<PluginsContext>[] = [];
        const onEndHandler: OnSubscribeResultResultOnEndHook[] = [];

        for (const afterCb of afterCalls) {
          const hookResult = afterCb({
            args: args as TypedSubscriptionArgs<PluginsContext>,
            result,
            setResult: newResult => {
              result = newResult;
            },
          });
          if (hookResult) {
            if (hookResult.onNext) {
              onNextHandler.push(hookResult.onNext);
            }
            if (hookResult.onEnd) {
              onEndHandler.push(hookResult.onEnd);
            }
          }
        }

        if (onNextHandler.length && isAsyncIterable(result)) {
          result = mapAsyncIterator(result, async result => {
            for (const onNext of onNextHandler) {
              await onNext({
                args: args as TypedSubscriptionArgs<PluginsContext>,
                result,
                setResult: newResult => (result = newResult),
              });
            }
            return result;
          });
        }
        if (onEndHandler.length && isAsyncIterable(result)) {
          result = finalAsyncIterator(result, () => {
            for (const onEnd of onEndHandler) {
              onEnd();
            }
          });
        }

        if (subscribeErrorHandlers.length && isAsyncIterable(result)) {
          result = errorAsyncIterator(result, err => {
            let error = err;
            for (const handler of subscribeErrorHandlers) {
              handler({
                error,
                setError: err => {
                  error = err;
                },
              });
            }
            throw error;
          });
        }

        return result as AsyncIterableIterator<ExecutionResult>;
      })
    : makeSubscribe(subscribe as any);

  const useCustomExecute = beforeCallbacks.execute.length || onResolversHandlers.length;

  const customExecute = useCustomExecute
    ? makeExecute(async args => {
        let executeFn = execute as ExecuteFunction;
        let result: AsyncIterableIteratorOrValue<ExecutionResult> | undefined;

        const afterCalls: OnExecuteDoneHook<PluginsContext>[] = [];
        let context = (args.contextValue as {}) || {};

        for (const onExecute of beforeCallbacks.execute) {
          const after = await onExecute({
            executeFn,
            setExecuteFn: newExecuteFn => {
              executeFn = newExecuteFn;
            },
            setResultAndStopExecution: stopResult => {
              result = stopResult;
            },
            extendContext: extension => {
              if (typeof extension === 'object') {
                context = {
                  ...(context || {}),
                  ...extension,
                };
              } else {
                throw new Error(
                  `Invalid context extension provided! Expected "object", got: "${JSON.stringify(
                    extension
                  )}" (${typeof extension})`
                );
              }
            },
            args: args as TypedExecutionArgs<PluginsContext>,
          });

          if (after?.onExecuteDone) {
            afterCalls.push(after.onExecuteDone);
          }

          if (result !== undefined) {
            break;
          }
        }

        if (onResolversHandlers.length) {
          context[resolversHooksSymbol] = onResolversHandlers;
        }

        if (result === undefined) {
          result = (await executeFn({
            ...args,
            contextValue: context,
          })) as AsyncIterableIteratorOrValue<ExecutionResult>;
        }

        const onNextHandler: OnExecuteDoneHookResultOnNextHook<PluginsContext>[] = [];
        const onEndHandler: OnExecuteDoneHookResultOnEndHook[] = [];

        for (const afterCb of afterCalls) {
          const hookResult = await afterCb({
            args: args as TypedExecutionArgs<PluginsContext>,
            result,
            setResult: newResult => {
              result = newResult;
            },
          });
          if (hookResult) {
            if (hookResult.onNext) {
              onNextHandler.push(hookResult.onNext);
            }
            if (hookResult.onEnd) {
              onEndHandler.push(hookResult.onEnd);
            }
          }
        }

        if (onNextHandler.length && isAsyncIterable(result)) {
          result = mapAsyncIterator(result, async result => {
            for (const onNext of onNextHandler) {
              await onNext({
                args: args as TypedExecutionArgs<PluginsContext>,
                result,
                setResult: newResult => {
                  result = newResult;
                },
              });
            }
            return result;
          });
        }
        if (onEndHandler.length && isAsyncIterable(result)) {
          result = finalAsyncIterator(result, () => {
            for (const onEnd of onEndHandler) {
              onEnd();
            }
          });
        }

        return result;
      })
    : makeExecute(execute);

  initDone = true;

  // This is done in order to trigger the first schema available, to allow plugins that needs the schema
  // eagerly to have it.
  if (schema) {
    for (const [i, plugin] of plugins.entries()) {
      plugin.onSchemaChange &&
        plugin.onSchemaChange({
          schema,
          replaceSchema: modifiedSchema => replaceSchema(modifiedSchema, i),
        });
    }
  }

  return {
    getCurrentSchema() {
      return schema;
    },
    init,
    parse: customParse,
    validate: customValidate,
    execute: customExecute as ExecuteFunction,
    subscribe: customSubscribe,
    contextFactory: customContextFactory,
  };
}
