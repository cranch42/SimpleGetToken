const selection = figma.currentPage.selection;

if (selection.length === 0) {
  figma.notify('No layers selected!');
  figma.closePlugin();
} else {
  // ----------------------------------------------------
  // 1. Кэш для LibraryVariable (список переменных из библиотеки "Web")
  // ----------------------------------------------------
  let cachedWebVariablesMap: Map<string, LibraryVariable> | null = null;

  // ----------------------------------------------------
  // 2. Кэш для уже импортированных переменных
  // ----------------------------------------------------
  const importedVariablesCache = new Map<string, Variable>();

  // ----------------------------------------------------
  // Получаем LibraryVariable из библиотеки "Web" (один раз)
  // ----------------------------------------------------
  async function getWebLibraryVariables(): Promise<Map<string, LibraryVariable>> {
    // Если в кэше уже есть — возвращаем
    if (cachedWebVariablesMap) {
      return cachedWebVariablesMap;
    }

    // Иначе инициализируем
    cachedWebVariablesMap = new Map<string, LibraryVariable>();

    // Если метод недоступен, завершаем досрочно
    if (typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync !== 'function') {
      console.error('getAvailableLibraryVariableCollectionsAsync is not available in this API version.');
      return cachedWebVariablesMap; // пустой Map
    }

    // Получаем все библиотеки
    const allLibraries = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    console.log('Available libraries:', allLibraries.map(lib => lib.name));

    // Ищем библиотеку "Web"
    const targetLibrary = allLibraries.find(lib => lib.name === 'Web');
    if (!targetLibrary) {
      console.log('Library "Web" not found. Check the available library names in the console output.');
      return cachedWebVariablesMap; // пустой Map
    }

    // Получаем список LibraryVariable из библиотеки "Web"
    const variablesInLibrary = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(targetLibrary.key);
    console.log('Variables in Web library:', variablesInLibrary.map(v => v.name));

    // Создаём Map: { variableName -> LibraryVariable }
    for (const libVar of variablesInLibrary) {
      cachedWebVariablesMap.set(libVar.name, libVar);
    }

    return cachedWebVariablesMap;
  }

  // ----------------------------------------------------
  // Импортируем переменную (LibraryVariable -> Variable) с учётом кэша
  // ----------------------------------------------------
  async function getImportedVariable(libVar: LibraryVariable): Promise<Variable> {
    // Если уже импортировали — возвращаем из кэша
    if (importedVariablesCache.has(libVar.key)) {
      return importedVariablesCache.get(libVar.key)!;
    }

    // Иначе импортируем
    const importedVar = await figma.variables.importVariableByKeyAsync(libVar.key);
    importedVariablesCache.set(libVar.key, importedVar);
    return importedVar;
  }

  // ----------------------------------------------------
  // Рекурсивная функция для обработки всех узлов
  // ----------------------------------------------------
  async function processNode(node: SceneNode, webVariablesMap: Map<string, LibraryVariable>) {
    // Собираем все связанные переменные (fill/stroke)
    async function collectBoundVariables(node: SceneNode) {
      const boundVariables: { type: 'Fill' | 'Stroke'; name: string }[] = [];

      // Работаем с fills
      if ('fills' in node && Array.isArray(node.fills)) {
        for (const fill of node.fills as readonly SolidPaint[]) {
          if (fill.boundVariables?.color?.id) {
            const variable = await figma.variables.getVariableByIdAsync(fill.boundVariables.color.id);
            if (variable) {
              console.log(`Collected Fill Variable: ${variable.name}`);
              boundVariables.push({ type: 'Fill', name: variable.name });
            }
          }
        }
      }

      // Работаем со strokes
      if ('strokes' in node && Array.isArray(node.strokes)) {
        for (const stroke of node.strokes as readonly SolidPaint[]) {
          if (stroke.boundVariables?.color?.id) {
            const variable = await figma.variables.getVariableByIdAsync(stroke.boundVariables.color.id);
            if (variable) {
              console.log(`Collected Stroke Variable: ${variable.name}`);
              boundVariables.push({ type: 'Stroke', name: variable.name });
            }
          }
        }
      }

      return boundVariables;
    }

    // Очищаем связанные переменные
    function clearBoundVariables(node: SceneNode) {
      if ('fills' in node && Array.isArray(node.fills)) {
        node.fills = node.fills.map(fill => {
          if (fill.type === 'SOLID' && fill.boundVariables) {
            console.log('Clearing Fill Variable');
            figma.variables.setBoundVariableForPaint(fill, 'color', null); // Убираем связанную переменную
            const { boundVariables, ...cleanedFill } = fill; // Убираем ключ boundVariables
            return cleanedFill;
          }
          return fill;
        });
      }

      if ('strokes' in node && Array.isArray(node.strokes)) {
        node.strokes = node.strokes.map(stroke => {
          if (stroke.type === 'SOLID' && stroke.boundVariables) {
            console.log('Clearing Stroke Variable');
            figma.variables.setBoundVariableForPaint(stroke, 'color', null); // Убираем связанную переменную
            const { boundVariables, ...cleanedStroke } = stroke; // Убираем ключ boundVariables
            return cleanedStroke;
          }
          return stroke;
        });
      }
    }


    // Применяем переменные из библиотеки "Web"
    async function applyWebVariables(node: SceneNode, collectedVariables: { type: 'Fill' | 'Stroke'; name: string }[]) {
      for (const { type, name } of collectedVariables) {
        console.log(`Looking for matching variable: ${name}`);
        const matchingLibraryVar = webVariablesMap.get(name);
        if (matchingLibraryVar) {
          console.log(`Found matching library variable: ${matchingLibraryVar.name}`);
          // Импортируем в локальный файл (получаем объект типа Variable)
          const importedVariable = await getImportedVariable(matchingLibraryVar);

          if (type === 'Fill' && 'fills' in node && Array.isArray(node.fills)) {
            node.fills = node.fills.map(fill => {
              if (fill.type === 'SOLID') {
                console.log(`Applying variable to Fill: ${matchingLibraryVar.name}`);
                return figma.variables.setBoundVariableForPaint(fill, 'color', importedVariable);
              }
              return fill;
            });
          }

          if (type === 'Stroke' && 'strokes' in node && Array.isArray(node.strokes)) {
            node.strokes = node.strokes.map(stroke => {
              if (stroke.type === 'SOLID') {
                console.log(`Applying variable to Stroke: ${matchingLibraryVar.name}`);
                return figma.variables.setBoundVariableForPaint(stroke, 'color', importedVariable);
              }
              return stroke;
            });
          }
        } else {
          console.log(`No matching variable found in "Web" for Name: ${name}`);
        }
      }
    }

    const collectedVariables = await collectBoundVariables(node);
    clearBoundVariables(node);
    await applyWebVariables(node, collectedVariables);

    // Рекурсивно обрабатываем потомков
    if ('children' in node) {
      for (const child of node.children) {
        await processNode(child, webVariablesMap);
      }
    }
  }

  // ----------------------------------------------------
  // Главная функция
  // ----------------------------------------------------
  async function processSelection() {
    // Получаем кэшированные LibraryVariable из библиотеки "Web"
    const webVariablesMap = await getWebLibraryVariables();

    for (const layer of selection) {
      await processNode(layer, webVariablesMap);
    }
    figma.notify('Variables replaced where applicable.');
    figma.closePlugin();
  }

  processSelection();
}
