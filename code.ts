// -------------------------------------
// Оптимизированный плагин Figma с BFS + Chunking и ограничением запросов
// -------------------------------------

if (figma.currentPage.selection.length === 0) {
  figma.notify('Нет выбранных слоёв!');
  figma.closePlugin();
} else {
  const WEB_LIBRARY_NAME = 'Web';
  const CHUNK_SIZE = 50; // Уменьшено для снижения нагрузки
  const MAX_CONCURRENT_REQUESTS = 5; // Максимальное количество параллельных запросов

  let cachedWebVariablesMap: Map<string, LibraryVariable> | null = null;
  const importedVariablesCache = new Map<string, Variable>();

  // FIFO очередь для управления параллельными запросами
  class RequestQueue {
    private queue: (() => Promise<void>)[] = [];
    private activeCount = 0;

    constructor(private maxConcurrency: number) {}

    enqueue(fn: () => Promise<void>) {
      this.queue.push(fn);
      this.next();
    }

    private next() {
      if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
        return;
      }
      const fn = this.queue.shift()!;
      this.activeCount++;
      fn().finally(() => {
        this.activeCount--;
        this.next();
      });
    }

    async waitUntilEmpty() {
      while (this.activeCount > 0 || this.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  const requestQueue = new RequestQueue(MAX_CONCURRENT_REQUESTS);

  // BFS для получения всех узлов в выборе
  function getAllNodesInSelection(selection: readonly SceneNode[]): SceneNode[] {
    const queue: SceneNode[] = [...selection];
    const result: SceneNode[] = [];

    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);

      if ('children' in node) {
        queue.push(...node.children);
      }
    }

    return result;
  }

  // Проверка, вложен ли узел внутри инстанса
  function isNestedInInstance(node: SceneNode): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === 'INSTANCE') return true;
      current = current.parent;
    }
    return false;
  }

  // Функция для ожидания перед повторной попыткой
  function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Повторные попытки с экспоненциальной задержкой
  async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      if (retries > 0 && error.status === 429) {
        console.warn(`Получен 429. Повторная попытка через ${delayMs} мс...`);
        await wait(delayMs);
        return withRetry(fn, retries - 1, delayMs * 2);
      }
      throw error;
    }
  }

  // Получение данных библиотеки Web с кэшированием и повторными попытками
  async function getWebLibraryData(): Promise<Map<string, LibraryVariable>> {
    if (cachedWebVariablesMap) return cachedWebVariablesMap;

    cachedWebVariablesMap = new Map<string, LibraryVariable>();

    if (
      typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync !== 'function'
    ) {
      console.warn(
        'getAvailableLibraryVariableCollectionsAsync недоступен в этой версии API.'
      );
      return cachedWebVariablesMap;
    }

    try {
      const allLibraries = await withRetry(() =>
        figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()
      );
      const targetLibrary = allLibraries.find(lib => lib.name === WEB_LIBRARY_NAME);
      if (!targetLibrary) {
        console.warn(`Библиотека "${WEB_LIBRARY_NAME}" не найдена.`);
        return cachedWebVariablesMap;
      }

      const variablesInLibrary = await withRetry(() =>
        figma.teamLibrary.getVariablesInLibraryCollectionAsync(targetLibrary.key)
      );
      for (const libVar of variablesInLibrary) {
        cachedWebVariablesMap.set(libVar.name, libVar);
      }
    } catch (error) {
      console.error('Ошибка при получении данных библиотеки Web:', error);
    }

    return cachedWebVariablesMap;
  }

  // Импорт переменной по ключу с кэшированием и повторными попытками
  async function getImportedVariable(libVar: LibraryVariable): Promise<Variable | null> {
    if (importedVariablesCache.has(libVar.key)) {
      return importedVariablesCache.get(libVar.key)!;
    }
    try {
      const imported = await withRetry(() => figma.variables.importVariableByKeyAsync(libVar.key));
      importedVariablesCache.set(libVar.key, imported);
      return imported;
    } catch (error) {
      console.error(`Ошибка при импорте переменной ${libVar.key}:`, error);
      return null;
    }
  }

  // Проверка, принадлежит ли переменная коллекции Web
  function isFromWebCollection(variable: Variable, webCollectionId: string | null): boolean {
    return variable.variableCollectionId === webCollectionId;
  }

  // Обработка fills или strokes для одного узла
  async function processPaints(
    node: SceneNode,
    paintType: 'fills' | 'strokes',
    webVariablesMap: Map<string, LibraryVariable>,
    webCollectionId: string | null
  ) {
    const paints = (node as any)[paintType] as readonly Paint[] | undefined;
    if (!Array.isArray(paints)) return;

    const updatedPaints = await Promise.all(
      paints.map(async paint => {
        if (paint.type !== 'SOLID' || !paint.boundVariables?.color?.id) {
          return paint;
        }

        const variableId = paint.boundVariables.color.id;
        const variable = await withRetry(() => figma.variables.getVariableByIdAsync(variableId));
        if (!variable) {
          return paint;
        }

        // Пропускаем, если уже из коллекции Web
        if (webCollectionId && isFromWebCollection(variable, webCollectionId)) {
          return paint;
        }

        // Ищем соответствующую переменную в Web по имени
        const libVar = webVariablesMap.get(variable.name);
        if (!libVar) {
          // Если переменная не найдена в Web, оставляем существующую привязку
          return paint;
        }

        // Импортируем переменную из Web
        const imported = await getImportedVariable(libVar);
        if (!imported) {
          // Если импорт не удался, оставляем существующую привязку
          return paint;
        }

        // Назначаем новую переменную из Web
        return figma.variables.setBoundVariableForPaint(paint, 'color', imported);
      })
    );

    // Обновляем paints узла, если были изменения
    const paintsChanged = JSON.stringify(paints) !== JSON.stringify(updatedPaints);
    if (paintsChanged) {
      (node as any)[paintType] = updatedPaints;
    }
  }

  // Переприсвоение explicit variable modes для узла
  async function reassignVariableModes(
    node: SceneNode,
    webCollection: VariableCollection | null
  ) {
    if (!('explicitVariableModes' in node)) return;

    const typedNode = node as BaseNode & {
      explicitVariableModes?: Record<string, string>;
      clearExplicitVariableModeForCollection: (collection: VariableCollection) => void;
      setExplicitVariableModeForCollection: (
        collection: VariableCollection,
        modeId: string
      ) => void;
    };

    const modes = typedNode.explicitVariableModes;
    if (!modes || Object.keys(modes).length === 0) return;

    // Очищаем существующие режимы
    const collections = await Promise.all(
      Object.keys(modes).map(async collId => {
        try {
          return await withRetry(() => figma.variables.getVariableCollectionByIdAsync(collId));
        } catch (error) {
          console.error(`Ошибка при получении коллекции ${collId}:`, error);
          return null;
        }
      })
    );

    collections.forEach(coll => {
      if (coll) typedNode.clearExplicitVariableModeForCollection(coll);
    });

    if (!webCollection) return;

    // Переприсваиваем режимы коллекции Web
    Object.values(modes).forEach(modeId => {
      typedNode.setExplicitVariableModeForCollection(webCollection, modeId);
    });
  }

  // Обработка одного узла
  async function processSingleNode(
    node: SceneNode,
    webVariablesMap: Map<string, LibraryVariable>,
    webCollection: VariableCollection | null
  ) {
    const webCollectionId = webCollection?.id ?? null;

    await Promise.all([
      processPaints(node, 'fills', webVariablesMap, webCollectionId),
      processPaints(node, 'strokes', webVariablesMap, webCollectionId),
    ]);

    if (!isNestedInInstance(node)) {
      await reassignVariableModes(node, webCollection);
    }
  }

  // Обработка узлов по чанкам с ограничением параллельных запросов
  async function processNodesInChunks(
    nodes: SceneNode[],
    webVariablesMap: Map<string, LibraryVariable>,
    webCollection: VariableCollection | null
  ) {
    for (let i = 0; i < nodes.length; i += CHUNK_SIZE) {
      const chunk = nodes.slice(i, i + CHUNK_SIZE);

      chunk.forEach(node => {
        requestQueue.enqueue(async () => {
          try {
            await processSingleNode(node, webVariablesMap, webCollection);
          } catch (error) {
            console.error('Ошибка при обработке узла:', error);
          }
        });
      });

      // Логирование прогресса
      console.log(`Добавлено для обработки ${Math.min(i + CHUNK_SIZE, nodes.length)}/${nodes.length} узлов...`);
    }

    // Ожидание завершения всех запросов
    await requestQueue.waitUntilEmpty();
  }

  // Главная функция
  async function main() {
    const allNodes = getAllNodesInSelection(figma.currentPage.selection);

    if (allNodes.length === 0) {
      figma.notify('В выбранных слоях нет узлов для обработки!');
      figma.closePlugin();
      return;
    }

    // Получаем данные библиотеки Web
    const webVariablesMap = await getWebLibraryData();

    if (webVariablesMap.size === 0) {
      figma.notify(`В библиотеке "${WEB_LIBRARY_NAME}" не найдено переменных.`);
      figma.closePlugin();
      return;
    }

    // Определяем коллекцию Web
    let webCollection: VariableCollection | null = null;
    const firstLibVar = webVariablesMap.values().next().value;
    if (firstLibVar) {
      const imported = await getImportedVariable(firstLibVar);
      if (imported) {
        try {
          webCollection = await withRetry(() =>
            figma.variables.getVariableCollectionByIdAsync(imported.variableCollectionId)
          );
        } catch (error) {
          console.error('Ошибка при получении коллекции Web:', error);
        }
      }
    }

    // Обрабатываем все узлы по чанкам с ограничением запросов
    await processNodesInChunks(allNodes, webVariablesMap, webCollection);

    figma.notify('Готово! Переменные переприсвоены без зависаний.');
    figma.closePlugin();
  }

  // Выполняем главную функцию с обработкой ошибок
  main().catch(error => {
    console.error('Ошибка плагина:', error);
    figma.notify('Произошла ошибка. Проверьте консоль для деталей.');
    figma.closePlugin();
  });
}
