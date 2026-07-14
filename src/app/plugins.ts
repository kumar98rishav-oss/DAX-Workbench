/**
 * APP — Plugin composition root
 * Instantiates the registry bound to the live model and activates the built-in
 * plugins. Third-party plugins would be `.use()`-d here (or dynamically).
 */
import { PluginRegistry } from '@/application/plugins/registry'
import { BUILTIN_PLUGINS } from '@/application/plugins/builtin'
import { useApp } from './store'

export const pluginRegistry = new PluginRegistry(() => useApp.getState().model)

for (const plugin of BUILTIN_PLUGINS) pluginRegistry.use(plugin)
