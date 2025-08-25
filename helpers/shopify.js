export async function shopifyFetch({ query, variables, store }) {
  const response = await fetch(`https://${process.env[`${store}_SHOPIFY_STORE_DOMAIN`]}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': process.env[`${store}_SHOPIFY_STORE_ACCESS_TOKEN`],
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
};

export async function createStagedUpload({ documents, store }) {
  const mutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: documents.map(document=>{
      return {
        filename: `${document.url.split("/").at(-1).replaceAll("%", "_").trim()}`,
        mimeType: `application/${document.url.split("/").at(-1).split(".").at(-1)}`,
        resource: 'FILE',
        httpMethod: 'POST'
      }
    })
  };

  const data = await shopifyFetch({ query: mutation, variables, store });
  const result = data.stagedUploadsCreate;

  if (result.userErrors.length > 0) {
    throw new Error('stagedUploadsCreate error: ' + JSON.stringify(result.userErrors));
  }

  return result.stagedTargets;
};

export async function fetchS3FileBuffer({ s3Url }) {
  try {
    const res = await fetch(s3Url);
    return await res.arrayBuffer();
  } catch (error) {
    console.log("failed fetching file: ", s3Url.split("/").at(-1), error);
  }
};

export async function uploadToStagedUrl({ stagedTarget, fileBuffer }) {
  const formData = new FormData();
  stagedTarget.parameters.forEach(param => {
    formData.append(param.name, param.value);
  });
  formData.append('file', new Blob([fileBuffer]), 'file.pdf');

  const res = await fetch(stagedTarget.url, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    console.log("failed uploading file: ", stagedTarget.resourceUrl.split("/").at(-1));
    // throw new Error(`Staged upload failed with status ${res.status}`);
  }
};

export async function finalizeUpload({ stagedTargets, store }) {
  const mutation = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          alt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    files: stagedTargets.map(stagedTarget=>{
      return {
        originalSource: stagedTarget.resourceUrl,
        alt: `Uploaded ${store} File: ${stagedTarget.resourceUrl.split("/").at(-1)}`,
        contentType: "FILE"
      }
    })
  };

  const data = await shopifyFetch({ query: mutation, variables, store });
  const result = data.fileCreate;

  if (result.userErrors.length > 0) {
    throw new Error('fileCreate error: ' + JSON.stringify(result.userErrors));
  }

  return result.files;
};

export async function createProductAPI({ productData, store, metafields }) {
  // check if there are images in the product
  var product_images = null;
  if(productData.attributes.media.images.length > 0 && productData.attributes.media.images.filter(image=>image.big).length > 0)product_images = productData.attributes.media.images.filter(image=>image.big).map(image=>{
    return {
      originalSource: image.big,
      mediaContentType: 'IMAGE',
      alt: `Uploaded ${store} Image`
    }
  }).flat();

  // check if there are videos in the product
  var product_videos = null;
  if(productData.attributes.media.videos.length > 0)product_videos = productData.attributes.media.videos.map(video=>{
    return {
      originalSource: video.url,
      mediaContentType: 'VIDEO',
      alt: `Uploaded ${store} Video`,
    }
  });

  const create_product_mutation = `
    mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product {
          id
          title
          variants(first: 1) {
            nodes {
              id
              sku
              inventoryItem {
                id
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    product: {
      title: `${productData.attributes.name} - ${productData.id}`,
      status: productData.attributes.is_old ? "DRAFT" : "ACTIVE",
      descriptionHtml: productData.attributes.description
    }
  };

  if(product_images && product_images.length > 0)variables.media = product_images;

  if(product_videos && product_videos.length > 0)variables.media = variables.media.concat(product_videos);

  if(metafields && metafields.length > 0)variables.product.metafields = metafields;

  return shopifyFetch({ query: create_product_mutation, variables, store });
};

export const product_all_metafields = {
  "description_plus": (value) => {
    return {
      namespace: "product",
      key: "description_plus",
      type: "multi_line_text_field",
      value
    }
  }, 
  "description_tech_spec": (value) => {
    return {
      namespace: "product",
      key: "description_tech_spec",
      type: "multi_line_text_field",
      value
    }
  },
  "popup_info": (value) => {
    return {
      namespace: "product",
      key: "popup_info",
      type: "single_line_text_field",
      value
    }
  },
  "best_category": (value) => {
    return {
      namespace: "product",
      key: "best_category",
      type: "single_line_text_field",
      value: value.toString()
    }
  },
  "is_old": (value) => {
    return {
      namespace: "product",
      key: "is_old",
      type: "boolean",
      value: value.toString()
    }
  },
  "is_new": (value) => {
    return {
      namespace: "product",
      key: "is_new",
      type: "boolean",
      value: value.toString()
    }
  },
  "is_good_deal": (value) => {
    return {
      namespace: "product",
      key: "is_good_deal",
      type: "boolean",
      value: value.toString()
    }
  },
  "page_catalog_number": (value) => {
    return {
      namespace: "product",
      key: "page_catalog_number",
      type: "single_line_text_field",
      value
    }
  },
  "page_promo_number": (value) => {
    return {
      namespace: "product",
      key: "page_promo_number",
      type: "single_line_text_field",
      value
    }
  },
  "restock_info": (value) => {
    return {
      namespace: "product",
      key: "restock_info",
      type: "single_line_text_field",
      value
    }
  },
  "supplier_delivery_delay": (value) => {
    return {
      namespace: "product",
      key: "supplier_delivery_delay",
      type: "number_integer",
      value: value.toString()
    }
  },
  "days_to_restock_avg": (value) => {
    return {
      namespace: "product",
      key: "days_to_restock_avg",
      type: "number_integer",
      value: value.toString()
    }
  },
  "length_mm": (value) => {
    return {
      namespace: "product",
      key: "length_mm",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "width_mm": (value) => {
    return {
      namespace: "product",
      key: "width_mm",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "height_mm": (value) => {
    return {
      namespace: "product",
      key: "height_mm",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "volume_m3": (value) => {
    return {
      namespace: "product",
      key: "volume_m3",
      type: "number_decimal",
      value: value.toString()
    }
  },
  // "weight": (value) => {
  //   return {
  //     namespace: "product",
  //     key: "weight",
  //     type: "number_integer",
  //     value: value.toString()
  //   }
  // },
  // "weight_unit": (value) => {
  //   return {
  //     namespace: "product",
  //     key: "weight_unit",
  //     type: "single_line_text_field",
  //     value: value.trim()
  //   }
  // },
  "vapor": (value) => {
    return {
      namespace: "product",
      key: "vapor",
      type: "single_line_text_field",
      value: value.toString()
    }
  },
  "electric_power_kw": (value) => {
    return {
      namespace: "product",
      key: "electric_power_kw",
      type: "number_decimal",
      value: value.toString()
    }
  },
  "electric_connection": (value) => {
    return {
      namespace: "product",
      key: "electric_connection",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "electric_connection_2": (value) => {
    return {
      namespace: "product",
      key: "electric_connection_2",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "electric_power_c_neg": (value) => {
    return {
      namespace: "product",
      key: "electric_power_c_neg",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "electric_power_c_pos": (value) => {
    return {
      namespace: "product",
      key: "electric_power_c_pos",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "horse_power": (value) => {
    return {
      namespace: "product",
      key: "horse_power",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "kcal_power": (value) => {
    return {
      namespace: "product",
      key: "kcal_power",
      type: "number_integer",
      value: value.toString()
    }
  },
  "product_category_id": (value) => {
    return {
      namespace: "product",
      key: "product_category_id",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_category_name": (value) => {
    return {
      namespace: "product",
      key: "product_category_name",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_range_id": (value) => {
    return {
      namespace: "product",
      key: "product_range_id",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_range_name": (value) => {
    return {
      namespace: "product",
      key: "product_range_name",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_subrange_id": (value) => {
    return {
      namespace: "product",
      key: "product_subrange_id",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_subrange_name": (value) => {
    return {
      namespace: "product",
      key: "product_subrange_name",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_family_id": (value) => {
    return {
      namespace: "product",
      key: "product_family_id",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_family_name": (value) => {
    return {
      namespace: "product",
      key: "product_family_name",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_subfamily_id": (value) => {
    return {
      namespace: "product",
      key: "product_subfamily_id",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_subfamily_name": (value) => {
    return {
      namespace: "product",
      key: "product_subfamily_name",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_line_id": (value) => {
    return {
      namespace: "product",
      key: "product_line_id",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "product_line_name": (value) => {
    return {
      namespace: "product",
      key: "product_line_name",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "has_accessories": (value) => {
    return {
      namespace: "product",
      key: "has_accessories",
      type: "number_integer",
      value: value.toString()
    }
  },
  "product_type": (value) => {
    return {
      namespace: "product",
      key: "product_type",
      type: "number_integer",
      value: value.toString()
    }
  },
  "count_accessories": (value) => {
    return {
      namespace: "product",
      key: "count_accessories",
      type: "number_integer",
      value: value.toString()
    }
  },
  "brand": (value) => {
    return {
      namespace: "product",
      key: "brand",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "cusref": (value) => {
    return {
      namespace: "product",
      key: "cusref",
      type: "single_line_text_field",
      value: value.toString()
    }
  },
  "eancod": (value) => {
    return {
      namespace: "product",
      key: "eancod",
      type: "single_line_text_field",
      value: value.trim()
    }
  },
  "eprel": (value) => {
    return {
      namespace: "product",
      key: "eprel",
      type: "json",
      value: JSON.stringify(value)
    }
  },
  "is_ups_ready": (value) => {
    return {
      namespace: "product",
      key: "is_ups_ready",
      type: "number_integer",
      value: value.toString()
    }
  },
  "product_tax": (value) => {
    return {
      namespace: "product",
      key: "product_tax",
      type: "number_decimal",
      value: value.toString()
    }
  },
  "availability_DBE12": (value) => {
    return {
      namespace: "product",
      key: "availability_DBE12",
      type: "number_integer",
      value: value.toString()
    }
  }
};

export const remaining_metafield_keys = [
  "description_plus", 
  "description_tech_spec",
  "popup_info",
  "best_category",
  "is_old",
  "is_new",
  "is_good_deal",
  "page_catalog_number",
  "page_promo_number",
  "restock_info",
  "supplier_delivery_delay",
  "days_to_restock_avg",
  "length_mm",
  "width_mm",
  "height_mm",
  "volume_m3",
  "vapor",
  "electric_power_kw",
  "electric_connection",
  "electric_connection_2",
  "electric_power_c_neg",
  "electric_power_c_pos",
  "horse_power",
  "kcal_power",
  "product_category_id",
  "product_category_name",
  "product_range_id",
  "product_range_name",
  "product_subrange_id",
  "product_subrange_name",
  "product_family_id",
  "product_family_name",
  "product_subfamily_id",
  "product_subfamily_name",
  "product_line_id",
  "product_line_name",
  "has_accessories",
  "product_type",
  "count_accessories",
  "brand",
  "cusref",
  "eancod",
  "eprel",
  "is_ups_ready",
  "product_tax",
  "availability_DBE12"
];

export const store_data = {
  "DIAMOND": {
    product_menu: {
      "Kochgeräte": [
        "Baeckereioefen",
        "Bain-marie",
        "BBQ Holzkohlegrill",
        "Chinaherde",
        "Dampfgarer",
        "Durchlauf Toaster",
        "Durchlauföfen",
        "Friteusen",
        "Gamma Drop In / Show Cooking",
        "Grillplatten",
        "Gyros Kebab Geraet",
        "Herd EL/GAS",
        "Hot-Dog Geräte",
        "Hähnchengrill",
        "INDUCTION-Platten",
        "Kochkessel & Kippbratpfanne",
        "Kochserie 900",
        "Kochserie 900+",
        "Kochserie MAXIMA 700+",
        "Kochserie Modular ALPHA 650",
        "Kochserie OPTIMA 1100",
        "Kochserie OPTIMA 700",
        "Kochserie 600",
        "Kochserie PRO 600",
        "Kochserie Snack 600",
        "Kombidämpfer Direkt",
        "Konvektionsöfen",
        "Lavastein-/Vaporgrill",
        "Mikrowellen",
        "Nudelkocher",
        "Ofen",
        "Panini Kontaktgrill",
        "Regenationsöfen",
        "Räuchergeräte",
        "Salamander",
        "Salzstationen",
        "Sous-vide Garer",
        "Speisenwarmhaltung",
        "Teppanyaki",
        "Toaster",
        "Toaster-Salamander",
        "Ultraschnelle Mikrowellenöfen",
        "Vapor Grill",
        "Waermeschrank",
        "Warme Vitrinen",
        "Wärmebrücken"
      ],
      "Cook & Chill": [
        "Hordenwagen",
        "Kombidämpfer",
        "Kombidämpfer Direkt",
        "Schockfroster/-kühler"
      ],
      "Spülung": [
        "Besteckpoliermaschinen",
        "Durchschubspülmaschine",
        "Durchschubspülmaschine Crossover",
        "Geschirrspülmaschinen",
        "Gläserspülmaschinen",
        "Kit Geschirrspüler & Spültisch",
        "Korbtransportsplmaschine",
        "Körbe & Zubehör",
        "Osmose Anlage",
        "Spuehlmaschinen/Glaeserspuehlmaschine",
        "Topfsp lmaschine",
        "Wasserenthaerter",
        "Zu- & Auslauftische",
        "Zubehör"
      ],
      "Wäscherei": [
        "Dampfbügelbrett/-eisen",
        "Lave-linges professionnels",
        "Mangel",
        "Rotationstrockner",
        "Schleudermaschinen",
        "Waschmaschine",
        "Waschturm",
        "Wäschetrockner"
      ],
      "Kühlung": [
        "Eiswürfelbereiter",
        "Flaschenkuehlschranke",
        "Gefriertruhen",
        "Getraenkedespender",
        "Granita- und Sorbet Despenser",
        "Kuehl/Gefrierkuehlzellen",
        "Kuehl/Gefrieschraenke",
        "Kuehlzellen +Kuehlaggregat",
        "Khl- und Gefriertische",
        "Kühlaufsatzvetrinen GN",
        "Lagerschraenke und Boxen",
        "Minibar-Kuehlschraenke",
        "Muellkuehler",
        "Reif & Gaerschrank",
        "Saladetten",
        "Schnellabkuehler/Kombischnellabkuehler",
        "Schnellabkuehlung",
        "Schockfroster/-kühler",
        "Selbstbedienungs-Gondeln",
        "Springbrunnen & Wasserkuehler",
        "Unterbaukuehler",
        "Vitrinen-Theken",
        "Vitrines T° positive & negative",
        "Wandkühlregale",
        "Weinschraenke"
      ],
      "Ice cream": [
        "Edelstahl-Behaelter fuer Eiscreme",
        "Eiscreme-Lagerung",
        "Eiscreme-Theken",
        "Eiscreme-Turbinen",
        "Kombi-Pasteurisierer-Turbinen",
        "Pasteurisiermaschine",
        "Sahne- Sosenkocher",
        "Sahnemaschine",
        "Vitrinen-Theken",
        "Waffelmaschinen"
      ],
      "Konditorei - Bäckerei": [
        "Baeckereioefen",
        "Edelstahl Möbel",
        "Gärkühlschränke",
        "Gärschraenke fuer Oefen",
        "Oefen und Baeckereioefen",
        "Ofen Drehbar",
        "Planetenruehrmixer",
        "Spiralteigknetmaschine - HEAVY DUTY",
        "Teigausrollmaschine"
      ],
      "Pizza - Pasta": [
        "Khl- und Gefriertische",
        "Durchlaufoefen",
        "Mozzarellaschneider",
        "Nudelmaschine",
        "Pizza-Former",
        "Pizzaoefen",
        "Spiralteigknetmaschine",
        "Teigausrollmaschine",
        "Teigportioniermaschine & Teigabrundmaschine",
        "Teigwalze",
        "Waermeplatten",
        "Warme Vitrinen",
        "Zubehoer / Pizza",
        "Zubehoer Pizzeria"
      ],
      "Selfs-Service - Buffets": [
        "Buffets",
        "Buffets / Salad Theken",
        "Inseln",
        "Kuehlvetrinen",
        "Modulare Self-service 700",
        "Modulare Self-service 800",
        "Salatbar Insel",
        "Self Drop In",
        "Self Drop In ARMONIA",
        "Tapas und Sushi-Vitrinen",
        "Wandkuehlregal",
        "Warme Vitrinen"
      ],
      "Food & Bar": [
        "Modules de composition"
      ],
      "Wagen - GN Behalter": [
        "Bain-marie Wagen",
        "Geschirrkorbwagen",
        "GN Behälter",
        "Mehl-/Zuckerwagen in Edelstahl",
        "Regalwagen",
        "Servierwagen Edelstahl",
        "Speisewagen gekühlt",
        "Spenderwagen",
        "Tellerhalter",
        "Universaltransportwagen",
        "Waermewagen",
        "Wagen neutral"
      ],
      "Coffee bar - Tea room": [
        "Crasheis",
        "Crepes Platte",
        "Croissant-Waermevetrine",
        "Frühstücksdienst",
        "Espresso-Kaffeemaschinen",
        "Getraenkedespender",
        "Kaffeemaschinen",
        "Kaffeemuehlen",
        "Mischer",
        "Mixer",
        "Profi-Zentrifugen",
        "Schokoladen-Sosen Waermer",
        "Sockel mit Kaffeesatzschublade",
        "Tassenwaermer",
        "Waffelmaschinen",
        "Warmwasserboiler",
        "Wasserenthaerter aus Edelstahl",
        "Vitrines T° positive & negative",
        "Zitruspresse"
      ],
      "Dynamische Vorbereitung": [
        "Aufschnittmaschine",
        "Cutter",
        "Cutter Horizontal",
        "Fleisch-Muerber",
        "Fleischmixmaschine",
        "Fleischwolf",
        "Fleischwolf Standgeraet",
        "Gekuehlte Fleischwolf",
        "Gemueseschneider",
        "Gemuesewaescher",
        "Hackblock & Hackbrett",
        "Hackmesser & Parmesan Kaesereibe",
        "Kartoffelschaeler",
        "Knochensaege",
        "Kuechenwaage",
        "Muschelreinigungsmaschine",
        "Parmesan-Reibe",
        "Planetenruehrmixer",
        "Stabmixer",
        "Sterilisator fuer Messer",
        "Vakuum-Beutel",
        "Vakuummaschine",
        "Verpackungsfolie",
        "Wurstfueller"
      ],
      "Hospitality - Cleaning": [
        "Chariots de salle",
        "Flambierwagen",
        "Frühstücksdienst",
        "Hand-& Haartrockner",
        "Kofferwagen",
        "Möbel für Ihre Ausstellung",
        "Postes de Nettoyage",
        "Rezeptionswagen",
        "Room Service",
        "Service-Wagen",
        "Speisenwaermer & Waermeplatte",
        "Wagen fuer Flaschen",
        "Wagen mit Untergestell",
        "Zimmer-Wagen"
      ],
      "Reinigunsprodukte": [
        "Edelstahlpflege",
        "Entkarbonierungsmittel",
        "Fettlöser",
        "Glanzspuehlmittel Spuelmaschinen",
        "Reinger fuer groben Schmutz",
        "Spuelmittelreiniger fuer Spuehlmaschinen",
        "Spuelmittelreiniger Oefen",
        "Spuelung Reiniger Oefen"
      ],
      "STA. Vorbereitung - Hygiene": [
        "Abfalleimer in Edelstahl",
        "Ablagetische",
        "Bodenablaufrinnen",
        "Chef Tisch",
        "Eckarbeitstische 90°",
        "Eckedelstahlschrank geschlossen",
        "Eckwandhaengeschraenke",
        "Edelstahlschrank",
        "Edelstahlspuelbecken",
        "Edelstahltische mit Grundboden",
        "Edelstahltische mit Schubladen",
        "Etagères Chef neutres",
        "Hand-& Haartrockner",
        "Handwaschbecken",
        "Insektenvernichter",
        "Kombiausgussbecken",
        "Lagerregale",
        "Lagerschraenke",
        "Muellbeutelhalter",
        "Neutrale & beheizte Chef-Regale",
        "Ozonbehandlung",
        "Papierdespenser",
        "Regale in Alluminium",
        "Spuelbecken mit Zwischenablage",
        "Tellerwärmer",
        "Vorbereitungskuehltische",
        "Wandkuehlregale",
        "Wandregale",
        "Wascharmaturen und Pendelbrausen",
        "Waschbecken geschlossen",
        "Wärmebrücken"
      ],
      "Lüftung - Ventilation": [
        "Absaugeinheit",
        "Absaugeinheiten mit separiertem Luftstrom",
        "Beleuchtungseinsats",
        "Drehzahlregler",
        "Eletrischer Schaltkasten",
        "Filternde Absaugeinheiten",
        "Wandhauben",
        "Wandhauben Kompensation",
        "Wandhauben mit Regler und Licht",
        "Zentralhauben",
        "Zentralhauben Kompensation"
      ],
    },
    product_all_metafields: {
      "description_plus": (value) => {
        return {
          namespace: "product",
          key: "description_plus",
          type: "multi_line_text_field",
          value
        }
      }, 
      "description_tech_spec": (value) => {
        return {
          namespace: "product",
          key: "description_tech_spec",
          type: "multi_line_text_field",
          value
        }
      },
      "popup_info": (value) => {
        return {
          namespace: "product",
          key: "popup_info",
          type: "single_line_text_field",
          value
        }
      },
      "best_category": (value) => {
        return {
          namespace: "product",
          key: "best_category",
          type: "single_line_text_field",
          value: value.toString()
        }
      },
      "is_old": (value) => {
        return {
          namespace: "product",
          key: "is_old",
          type: "boolean",
          value: value.toString()
        }
      },
      "is_new": (value) => {
        return {
          namespace: "product",
          key: "is_new",
          type: "boolean",
          value: value.toString()
        }
      },
      "is_good_deal": (value) => {
        return {
          namespace: "product",
          key: "is_good_deal",
          type: "boolean",
          value: value.toString()
        }
      },
      "page_catalog_number": (value) => {
        return {
          namespace: "product",
          key: "page_catalog_number",
          type: "single_line_text_field",
          value
        }
      },
      "page_promo_number": (value) => {
        return {
          namespace: "product",
          key: "page_promo_number",
          type: "single_line_text_field",
          value
        }
      },
      "restock_info": (value) => {
        return {
          namespace: "product",
          key: "restock_info",
          type: "single_line_text_field",
          value
        }
      },
      "supplier_delivery_delay": (value) => {
        return {
          namespace: "product",
          key: "supplier_delivery_delay",
          type: "number_integer",
          value: value.toString()
        }
      },
      "days_to_restock_avg": (value) => {
        return {
          namespace: "product",
          key: "days_to_restock_avg",
          type: "number_integer",
          value: value.toString()
        }
      },
      "length_mm": (value) => {
        return {
          namespace: "product",
          key: "length_mm",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "width_mm": (value) => {
        return {
          namespace: "product",
          key: "width_mm",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "height_mm": (value) => {
        return {
          namespace: "product",
          key: "height_mm",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "volume_m3": (value) => {
        return {
          namespace: "product",
          key: "volume_m3",
          type: "number_decimal",
          value: value.toString()
        }
      },
      // "weight": (value) => {
      //   return {
      //     namespace: "product",
      //     key: "weight",
      //     type: "number_integer",
      //     value: value.toString()
      //   }
      // },
      // "weight_unit": (value) => {
      //   return {
      //     namespace: "product",
      //     key: "weight_unit",
      //     type: "single_line_text_field",
      //     value: value.trim()
      //   }
      // },
      "vapor": (value) => {
        return {
          namespace: "product",
          key: "vapor",
          type: "single_line_text_field",
          value: value.toString()
        }
      },
      "electric_power_kw": (value) => {
        return {
          namespace: "product",
          key: "electric_power_kw",
          type: "number_decimal",
          value: value.toString()
        }
      },
      "electric_connection": (value) => {
        return {
          namespace: "product",
          key: "electric_connection",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "electric_connection_2": (value) => {
        return {
          namespace: "product",
          key: "electric_connection_2",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "electric_power_c_neg": (value) => {
        return {
          namespace: "product",
          key: "electric_power_c_neg",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "electric_power_c_pos": (value) => {
        return {
          namespace: "product",
          key: "electric_power_c_pos",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "horse_power": (value) => {
        return {
          namespace: "product",
          key: "horse_power",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "kcal_power": (value) => {
        return {
          namespace: "product",
          key: "kcal_power",
          type: "number_integer",
          value: value.toString()
        }
      },
      "product_category_id": (value) => {
        return {
          namespace: "product",
          key: "product_category_id",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_category_name": (value) => {
        return {
          namespace: "product",
          key: "product_category_name",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_range_id": (value) => {
        return {
          namespace: "product",
          key: "product_range_id",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_range_name": (value) => {
        return {
          namespace: "product",
          key: "product_range_name",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_subrange_id": (value) => {
        return {
          namespace: "product",
          key: "product_subrange_id",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_subrange_name": (value) => {
        return {
          namespace: "product",
          key: "product_subrange_name",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_family_id": (value) => {
        return {
          namespace: "product",
          key: "product_family_id",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_family_name": (value) => {
        return {
          namespace: "product",
          key: "product_family_name",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_subfamily_id": (value) => {
        return {
          namespace: "product",
          key: "product_subfamily_id",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_subfamily_name": (value) => {
        return {
          namespace: "product",
          key: "product_subfamily_name",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_line_id": (value) => {
        return {
          namespace: "product",
          key: "product_line_id",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "product_line_name": (value) => {
        return {
          namespace: "product",
          key: "product_line_name",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "has_accessories": (value) => {
        return {
          namespace: "product",
          key: "has_accessories",
          type: "number_integer",
          value: value.toString()
        }
      },
      "product_type": (value) => {
        return {
          namespace: "product",
          key: "product_type",
          type: "number_integer",
          value: value.toString()
        }
      },
      "count_accessories": (value) => {
        return {
          namespace: "product",
          key: "count_accessories",
          type: "number_integer",
          value: value.toString()
        }
      },
      "brand": (value) => {
        return {
          namespace: "product",
          key: "brand",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "cusref": (value) => {
        return {
          namespace: "product",
          key: "cusref",
          type: "single_line_text_field",
          value: value.toString()
        }
      },
      "eancod": (value) => {
        return {
          namespace: "product",
          key: "eancod",
          type: "single_line_text_field",
          value: value.trim()
        }
      },
      "eprel": (value) => {
        return {
          namespace: "product",
          key: "eprel",
          type: "json",
          value: JSON.stringify(value)
        }
      },
      "is_ups_ready": (value) => {
        return {
          namespace: "product",
          key: "is_ups_ready",
          type: "number_integer",
          value: value.toString()
        }
      },
      "product_tax": (value) => {
        return {
          namespace: "product",
          key: "product_tax",
          type: "number_decimal",
          value: value.toString()
        }
      },
      "availability_DBE12": (value) => {
        return {
          namespace: "product",
          key: "availability_DBE12",
          type: "number_integer",
          value: value.toString()
        }
      }
    },
    remaining_metafield_keys: [
      "description_plus", 
      "description_tech_spec",
      "popup_info",
      "best_category",
      "is_old",
      "is_new",
      "is_good_deal",
      "page_catalog_number",
      "page_promo_number",
      "restock_info",
      "supplier_delivery_delay",
      "days_to_restock_avg",
      "length_mm",
      "width_mm",
      "height_mm",
      "volume_m3",
      "vapor",
      "electric_power_kw",
      "electric_connection",
      "electric_connection_2",
      "electric_power_c_neg",
      "electric_power_c_pos",
      "horse_power",
      "kcal_power",
      "product_category_id",
      "product_category_name",
      "product_range_id",
      "product_range_name",
      "product_subrange_id",
      "product_subrange_name",
      "product_family_id",
      "product_family_name",
      "product_subfamily_id",
      "product_subfamily_name",
      "product_line_id",
      "product_line_name",
      "has_accessories",
      "product_type",
      "count_accessories",
      "brand",
      "cusref",
      "eancod",
      "eprel",
      "is_ups_ready",
      "product_tax",
      "availability_DBE12"
    ]
  }
};

export async function deleteProductAPI({ productId, store }) {
  const mutation = `
    mutation {
      productDelete(input: {id: "${productId}"}) {
        deletedProductId
        userErrors {
          field
          message
        }
      }
    }
  `;

  return shopifyFetch({ query: mutation, store });
};

export const uploadImagesToShopify = async ({ images, store }) => {
  const mutation = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          url
          alt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    files: images.map(image=>{
      return {
        originalSource: image.url,
        contentType: 'IMAGE',
        alt: `Uploaded ${store} Image`,
      }
    })
  };

  const data = await shopifyFetch({ mutation, variables, store });
  const result = data.fileCreate;

  if (result.userErrors.length > 0) {
    throw new Error('imageCreate error: ' + JSON.stringify(result.userErrors));
  }

  return result.files;
};

export const publishablePublish = async ({ id, publication, store }) => {
  const mutation = `
    mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          availablePublicationsCount {
            count
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id,
    input: {
      publicationId: publication.id
    }
  };

  return shopifyFetch({ query: mutation, variables, store });
};

export const getAllPublications = async ({ store }) => {
  const query = `
    query getPublications {
      publications(first: 250) {
        nodes {
          id
          name
        }
      }
    }
  `;

  return shopifyFetch({ query, store });
};

export async function updateMetafields({ metafields, store }) {
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    metafields
  };

  const data = await shopifyFetch({ query: mutation, variables, store });
  const result = data.metafieldsSet;

  if (result.userErrors.length > 0)return {
    status: "error",
    errors: result.userErrors
  };

  return {
    status: "success"
  };
};

export const uploadS3FilesToShopify = async ({ documents, store }) => {
  try {
    //Step 1: get staged (temporary) upload url for step 2
    // console.log('1️⃣ Creating staged upload...');
    const stagedTargets = await createStagedUpload({ documents, store });

    //Step 2 + 3 : get the file from S3 then upload the file to the returned url from step 1
    // console.log('2️⃣ + 3️⃣ get the file from S3 then upload the file to the returned url from step 1...');
    await Promise.all(documents.map(async (document)=>{
      const document_name = document.url.split("/").at(-1).replaceAll("%", "_").trim();
      const stagedTarget = stagedTargets.find(stagedTarget=>stagedTarget.resourceUrl.includes(`/${document_name}`))

      if(stagedTarget){
        //Step 2
        const fileBuffer = await fetchS3FileBuffer({ s3Url: document.url });

        //Step 3
        if(fileBuffer)await uploadToStagedUrl({ stagedTarget, fileBuffer });
      };
    }));

    //Step 4: upload file to Shopify using the return resourceUrl from step 1
    // console.log('4️⃣ Finalizing upload with fileCreate...');
    const files = await finalizeUpload({ stagedTargets, store });
    
    return {
      status: "success",
      error: null,
      files
    };
  } catch (error) {
    return {
      status: "error",
      error,
      files: []
    };
  }
};