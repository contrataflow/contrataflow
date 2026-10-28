import 'reflect-metadata';

import { Controller, Get, Injectable, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { withoutControllers } from './headless-modules.js';

const built: string[] = [];
const initialized: string[] = [];

@Injectable()
class CatalogService {
  readonly name = 'catalog';
}

@Controller('catalog')
class CatalogController {
  constructor() {
    built.push('CatalogController');
  }

  @Get()
  list(): string {
    return 'ok';
  }
}

@Module({
  providers: [CatalogService],
  controllers: [CatalogController],
  exports: [CatalogService],
})
class CatalogModule {}

@Injectable()
class DocumentService {
  constructor(readonly catalog: CatalogService) {}
}

@Controller('documents')
class DocumentController {
  constructor() {
    built.push('DocumentController');
  }
}

@Module({
  imports: [CatalogModule],
  providers: [DocumentService],
  controllers: [DocumentController],
})
class DocumentModule implements OnModuleInit {
  constructor(private readonly documents: DocumentService) {}

  onModuleInit(): void {
    initialized.push(this.documents.catalog.name);
  }
}

describe('withoutControllers (DEC-052 · contexto de jobs sem HTTP)', () => {
  it('copia os módulos sem controllers, com os mesmos providers e as importações trocadas', () => {
    const [document, catalog] = withoutControllers([DocumentModule, CatalogModule]);
    expect(document).not.toBe(DocumentModule);
    expect(document?.name).toBe('DocumentModule');
    expect(Reflect.getMetadata('controllers', document as object)).toEqual([]);
    expect(Reflect.getMetadata('providers', document as object)).toEqual([DocumentService]);
    // A cópia importa a cópia: o original (com controllers) não entra no grafo.
    expect(Reflect.getMetadata('imports', document as object)).toEqual([catalog]);
    expect(Reflect.getMetadata('exports', catalog as object)).toEqual([CatalogService]);
    // Os originais seguem intactos para a API.
    expect(Reflect.getMetadata('controllers', DocumentModule)).toEqual([DocumentController]);
  });

  it('sobe o contexto com os providers e os ganchos dos módulos sem instanciar controllers', async () => {
    built.length = 0;
    initialized.length = 0;
    const [document] = withoutControllers([DocumentModule, CatalogModule]);
    const context = await NestFactory.createApplicationContext(document as typeof DocumentModule, {
      logger: false,
    });
    try {
      expect(context.get(DocumentService, { strict: false }).catalog.name).toBe('catalog');
      expect(initialized).toEqual(['catalog']);
      expect(built).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
