import { Module } from '@nestjs/common';
import type { Type } from '@nestjs/common';

/*
 * Módulos da API sem a camada HTTP (DEC-052 · architecture.md §4.3): o worker monta o contexto de
 * jobs com os MESMOS providers dos módulos — repositórios, fachadas, registros de eventos
 * síncronos (timeline, auditoria), seeders — mas nunca instancia controllers. Cada módulo vira uma
 * subclasse com os metadados copiados e `controllers: []`; a subclasse herda os ganchos
 * (`onModuleInit`) e as dependências do construtor do original. Importações entre os módulos do
 * conjunto apontam para as cópias, para que o original (com controllers) nunca entre no grafo.
 */

type ModuleImport = NonNullable<Parameters<typeof Module>[0]['imports']>[number];
type ModuleExport = NonNullable<Parameters<typeof Module>[0]['exports']>[number];

function metadataOf<T>(key: string, module: Type): T[] {
  return (Reflect.getMetadata(key, module) as T[] | undefined) ?? [];
}

/** Cópias sem controllers de `modules`, na mesma ordem. */
export function withoutControllers(modules: readonly Type[]): Type[] {
  const set = new Set<unknown>(modules);
  const copies = new Map<Type, Type>();
  const swap = <T>(entry: T): T => (set.has(entry) ? (copyOf(entry as Type) as T) : entry);

  function copyOf(module: Type): Type {
    const existing = copies.get(module);
    if (existing) return existing;
    const Headless = class extends (module as Type<object>) {};
    Object.defineProperty(Headless, 'name', { value: module.name });
    copies.set(module, Headless);
    Module({
      imports: metadataOf<ModuleImport>('imports', module).map(swap),
      providers: metadataOf('providers', module),
      exports: metadataOf<ModuleExport>('exports', module).map(swap),
      controllers: [],
    })(Headless);
    return Headless;
  }

  return modules.map(copyOf);
}
