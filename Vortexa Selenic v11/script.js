document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_BASE_URL = 'http://127.0.0.1:5000';
    const EARTH_RADIUS = 50;
    const SATELLITE_ALTITUDE = 5;
    
    // --- STATE MANAGEMENT ---
    let state = {
        isPlaying: true, speedMultiplier: 100, direction: 1, elapsedSeconds: 0,
        lastTimestamp: performance.now(), isPopulationMapActive: false, spotbeamRadiusKm: 1300,
        lastData: null, lastPopulationScore: null, lastAreaKm2: null,
    };

    // --- DOM ELEMENTS ---
    const canvas = document.getElementById('globe-canvas');
    const populationTooltip = document.getElementById('population-tooltip');
    const togglePopulationBtn = document.getElementById('toggle-population-btn');
    const calculateScoreBtn = document.getElementById('calculate-score-btn');
    const calculateAreaBtn = document.getElementById('calculate-area-btn');
    const scoreDisplay = document.getElementById('score-display');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const reverseBtn = document.getElementById('reverse-btn');
    const forwardBtn = document.getElementById('forward-btn');
    const speedSlider = document.getElementById('speed-slider');
    const speedLabel = document.getElementById('speed-label');
    const timeDisplay = document.getElementById('time-display');
    const utcTimeDisplay = document.getElementById('utc-time-display');
    const calculateEconomicsBtn = document.getElementById('calculate-economics-btn');
    const adoptionRateSlider = document.getElementById('adoption-rate-slider');
    const adoptionRateLabel = document.getElementById('adoption-rate-label');
    const arpuSlider = document.getElementById('arpu-slider');
    const arpuLabel = document.getElementById('arpu-label');
    const economicDisplay = document.getElementById('economic-display');
    const latInput = document.getElementById('lat-input');
    const lonInput = document.getElementById('lon-input');
    const pinpointBtn = document.getElementById('pinpoint-btn');

    // --- NEW TLE UPDATER ELEMENTS ---
    const tleInput = document.getElementById('tle-input');
    const updateTleBtn = document.getElementById('update-tle-btn');

    // --- THREE.JS SETUP ---
    let scene, camera, renderer, earth, satellite, controls;
    let trailPoints = [];
    let spotbeamLine = null;
    let populationEarthTexture = null;
    let pinpointMarker = null; // Variable to hold our pin
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function initThreeJS() {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x090a0f); 
        scene.fog = new THREE.Fog(0x090a0f, 100, 200); 
        camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
        camera.position.z = 120;
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
        renderer.setSize(canvas.clientWidth, canvas.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
        scene.add(ambientLight);
        const earthGeometry = new THREE.SphereGeometry(EARTH_RADIUS, 64, 64);
        const textureLoader = new THREE.TextureLoader();
        const placeholderTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
        const earthMaterial = new THREE.ShaderMaterial({
            uniforms: {
                dayTexture: { value: textureLoader.load(`${API_BASE_URL}/static/textures/8k_earth_daymap.jpg`) },
                nightTexture: { value: textureLoader.load(`${API_BASE_URL}/static/textures/8k_earth_nightmap.jpg`) },
                populationTexture: { value: placeholderTexture },
                sunDirection: { value: new THREE.Vector3(1, 0, 0).normalize() },
                uShowPopulation: { value: false }
            },
            vertexShader: `
                varying vec2 vUv; varying vec3 vNormal; void main() {
                vUv = uv; vNormal = normalize(normalMatrix * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                uniform sampler2D dayTexture; uniform sampler2D nightTexture; uniform sampler2D populationTexture;
                uniform vec3 sunDirection; uniform bool uShowPopulation; varying vec2 vUv; varying vec3 vNormal;
                void main() { float intensity = pow(max(dot(vNormal, sunDirection), 0.0), 1.2);
                vec4 dayColor = texture2D(dayTexture, vUv); vec4 nightColor = texture2D(nightTexture, vUv);
                nightColor.rgb *= (0.15 + texture2D(nightTexture, vUv).r * 0.7);
                vec4 finalColor = mix(nightColor, dayColor, intensity);
                if (uShowPopulation) { vec4 popColor = texture2D(populationTexture, vUv);
                if (popColor.a > 0.05) { finalColor = mix(finalColor, popColor, popColor.a * 0.9); } }
                gl_FragColor = vec4(finalColor.rgb, 1.0); }`
        });
        earth = new THREE.Mesh(earthGeometry, earthMaterial);
        scene.add(earth);
        const atmosphereGeometry = new THREE.SphereGeometry(EARTH_RADIUS * 1.02, 64, 64);
        const atmosphereMaterial = new THREE.ShaderMaterial({
            vertexShader: `varying vec3 vNormal; void main() { vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `varying vec3 vNormal; void main() { float intensity = pow(0.7 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);
            gl_FragColor = vec4(0.3, 0.6, 1.0, 1.0) * intensity * 0.5; }`,
            blending: THREE.AdditiveBlending, side: THREE.BackSide
        });
        scene.add(new THREE.Mesh(atmosphereGeometry, atmosphereMaterial));
        const starGeometry = new THREE.BufferGeometry();
        const starVertices = [];
        for (let i = 0; i < 10000; i++) {
            const x = (Math.random() - 0.5) * 2000; const y = (Math.random() - 0.5) * 2000; const z = (Math.random() - 0.5) * 2000;
            starVertices.push(x, y, z);
        }
        starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starVertices, 3));
        scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0xffffff, size: 0.7, sizeAttenuation: true })));
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true; controls.dampingFactor = 0.05;
        canvas.addEventListener('mousemove', handleCanvasMouseMove);
        canvas.addEventListener('click', handleCanvasClick);
    }
    
    function latLonToVector3(lat, lon, radius) {
        const phi = (90 - lat) * Math.PI / 180;
        const theta = (lon + 180) * Math.PI / 180;
        return new THREE.Vector3(
            -radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.cos(phi),
            radius * Math.sin(phi) * Math.sin(theta)
        );
    }

    // --- NEW FUNCTION TO RESET THE SIMULATION ---
    function resetSimulation() {
        // Reset time
        state.elapsedSeconds = 0;
        state.lastPopulationScore = null;
        state.lastAreaKm2 = null;

        // Clear visual trails
        trailPoints = [];
        updateGroundTrack(); // Call to clear the line from the scene
        
        // Clear spotbeam
        if (spotbeamLine) {
            scene.remove(spotbeamLine);
            spotbeamLine.geometry.dispose();
            spotbeamLine.material.dispose();
            spotbeamLine = null;
        }

        // Clear pin
        if (pinpointMarker) {
            earth.remove(pinpointMarker);
            pinpointMarker.geometry.dispose();
            pinpointMarker.material.dispose();
            pinpointMarker = null;
        }

        // Clear results display
        scoreDisplay.textContent = '';
        economicDisplay.textContent = '';
    }
    
    // --- MODIFIED FUNCTION ---
    function placePin(lat, lon) {
        if (pinpointMarker) {
            earth.remove(pinpointMarker);
            pinpointMarker.geometry.dispose();
            pinpointMarker.material.dispose();
        }
        const pinGeometry = new THREE.SphereGeometry(0.7, 16, 16);
        const pinMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        pinpointMarker = new THREE.Mesh(pinGeometry, pinMaterial);
        const pinPosition = latLonToVector3(lat, lon, EARTH_RADIUS + 0.5);
        pinpointMarker.position.copy(pinPosition);
        earth.add(pinpointMarker);
    }
    
    function updateSatellitePosition(lat, lon) { if (!satellite) { satellite = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffff00 })); scene.add(satellite); } const position = latLonToVector3(lat, lon, EARTH_RADIUS + SATELLITE_ALTITUDE); satellite.position.copy(position); trailPoints.push(position.clone()); if (trailPoints.length > 1000) trailPoints.shift(); }
    function updateSpotbeam(polygon) { if (spotbeamLine) { scene.remove(spotbeamLine); spotbeamLine.geometry.dispose(); spotbeamLine.material.dispose(); } const points = polygon.map(p => latLonToVector3(p[1], p[0], EARTH_RADIUS + 0.2)); spotbeamLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.8 })); scene.add(spotbeamLine); }
    function updateGroundTrack() { const oldTrail = scene.getObjectByName('groundTrack'); if (oldTrail) { scene.remove(oldTrail); oldTrail.geometry.dispose(); oldTrail.material.dispose(); } if (trailPoints.length < 2) return; const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(trailPoints), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 })); trail.name = 'groundTrack'; scene.add(trail); }
    function getIntersectionLatLon(event) { const rect = canvas.getBoundingClientRect(); mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1; mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1; raycaster.setFromCamera(mouse, camera); const intersects = raycaster.intersectObject(earth); if (intersects.length > 0) { const p = intersects[0].point; const lat = 90 - (Math.acos(p.y / p.length()) * 180 / Math.PI); const lon = -((Math.atan2(p.z, p.x)) * 180 / Math.PI); return { lat, lon }; } return null; }
    function handleCanvasMouseMove(event) { if (!state.isPopulationMapActive) { populationTooltip.style.display = 'none'; return; } const coords = getIntersectionLatLon(event); if (coords) { populationTooltip.style.left = `${event.clientX}px`; populationTooltip.style.top = `${event.clientY}px`; populationTooltip.style.display = 'block'; populationTooltip.innerHTML = `Lat: ${coords.lat.toFixed(2)}, Lon: ${coords.lon.toFixed(2)}<br>Calculating...`; clearTimeout(window.populationDebounce); window.populationDebounce = setTimeout(() => fetchPopulationEstimate(coords.lat, coords.lon), 200); } else { populationTooltip.style.display = 'none'; } }
    function handleCanvasClick(event) { if (!state.isPopulationMapActive) return; const coords = getIntersectionLatLon(event); if (coords) { populationTooltip.innerHTML = `Lat: ${coords.lat.toFixed(2)}, Lon: ${coords.lon.toFixed(2)}<br>Fetching...`; fetchPopulationEstimate(coords.lat, coords.lon); } }
    function updateVisualization(data) { if (!data || data.latitude === undefined) { console.error("Received invalid data:", data); return; } updateSatellitePosition(data.latitude, data.longitude); updateSpotbeam(data.spotbeam_polygon); updateGroundTrack(); if (earth) { earth.rotation.y = (data.elapsed_seconds / 86400) * Math.PI * 2; } const days = Math.floor(data.elapsed_seconds / 86400); const time = new Date((data.elapsed_seconds % 86400) * 1000).toISOString().substr(11, 8); if (timeDisplay) timeDisplay.textContent = `Day ${String(days).padStart(2, '0')} / Hour ${time}`; if (utcTimeDisplay) utcTimeDisplay.textContent = `UTC: ${new Date(data.simulation_time_iso).toUTCString()}`; state.lastData = data; }
    function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
    function handleResize() { camera.aspect = canvas.clientWidth / canvas.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(canvas.clientWidth, canvas.clientHeight); }
    async function fetchData() { try { const response = await fetch(`${API_BASE_URL}/api/position?elapsed_seconds=${state.elapsedSeconds}&radius_km=${state.spotbeamRadiusKm}`); if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`); return await response.json(); } catch (error) { console.error("Could not fetch satellite data:", error); state.isPlaying = false; updatePlayPauseButton(); return null; } }
    async function togglePopulationMap() { const isActive = togglePopulationBtn.classList.contains('active'); if (isActive) { togglePopulationBtn.classList.remove('active'); state.isPopulationMapActive = false; populationTooltip.style.display = 'none'; if (earth) earth.material.uniforms.uShowPopulation.value = false; } else { togglePopulationBtn.textContent = 'Loading...'; togglePopulationBtn.disabled = true; try { if (populationEarthTexture) { earth.material.uniforms.uShowPopulation.value = true; } else { const response = await fetch(`${API_BASE_URL}/api/population-density`); if (!response.ok) throw new Error('Failed to get population map URL'); const data = await response.json(); const mapUrl = `${API_BASE_URL}${data.map_url}`; populationEarthTexture = await new THREE.TextureLoader().loadAsync(mapUrl); earth.material.uniforms.populationTexture.value = populationEarthTexture; earth.material.uniforms.uShowPopulation.value = true; } togglePopulationBtn.classList.add('active'); state.isPopulationMapActive = true; } catch (error) { console.error("Error toggling population map:", error); alert("Could not load the population density map."); } finally { togglePopulationBtn.textContent = 'View Population Density'; togglePopulationBtn.disabled = false; } } }
    async function calculateCoverageScore() { calculateScoreBtn.disabled = true; calculateScoreBtn.textContent = 'Calculating...'; scoreDisplay.textContent = ''; try { const response = await fetch(`${API_BASE_URL}/api/coverage-score`); if (!response.ok) throw new Error((await response.json()).error || 'Calculation failed'); const data = await response.json(); state.lastPopulationScore = data.coverage_score; scoreDisplay.textContent = `Population Score: ~${data.coverage_score.toLocaleString()}`; } catch (error) { console.error("Error calculating coverage score:", error); scoreDisplay.textContent = 'Error calculating score.'; } finally { calculateScoreBtn.disabled = false; calculateScoreBtn.textContent = 'by Population'; } }
    async function calculateCoverageArea() { calculateAreaBtn.disabled = true; calculateAreaBtn.textContent = 'Calculating...'; scoreDisplay.textContent = ''; try { const response = await fetch(`${API_BASE_URL}/api/coverage-area`); if (!response.ok) throw new Error((await response.json()).error || 'Calculation failed'); const data = await response.json(); state.lastAreaKm2 = data.coverage_area_km2; scoreDisplay.textContent = `Coverage Area: ~${data.coverage_area_km2.toLocaleString()} km²`; } catch (error) { console.error("Error calculating coverage area:", error); scoreDisplay.textContent = 'Error calculating area.'; } finally { calculateAreaBtn.disabled = false; calculateAreaBtn.textContent = 'by Area (km²)'; } }
    async function calculateEconomicAnalysis() { if (state.lastPopulationScore === null || state.lastAreaKm2 === null) { alert('Please calculate both "by Population" and "by Area" scores first.'); return; } calculateEconomicsBtn.disabled = true; calculateEconomicsBtn.textContent = 'Calculating...'; economicDisplay.textContent = 'Calculating...'; const adoptionRate = adoptionRateSlider.value / 100; const arpu = arpuSlider.value; const params = new URLSearchParams({ population: state.lastPopulationScore, area_km2: state.lastAreaKm2, adoption_rate: adoptionRate, arpu_monthly: arpu }); try { const response = await fetch(`${API_BASE_URL}/api/economic-analysis?${params}`); if (!response.ok) throw new Error((await response.json()).error || 'Calculation failed'); const data = await response.json(); let resultText = ''; for (const [key, value] of Object.entries(data)) { const formattedValue = Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}); resultText += `${key.padEnd(25)}: ${formattedValue}\n`; } economicDisplay.textContent = resultText; } catch (error) { console.error("Error calculating economics:", error); economicDisplay.textContent = 'Error calculating economics.'; } finally { calculateEconomicsBtn.disabled = false; calculateEconomicsBtn.textContent = 'Calculate Economics'; } }
    async function fetchPopulationEstimate(lat, lon) { try { if (isNaN(lat) || isNaN(lon)) return; const response = await fetch(`${API_BASE_URL}/api/population-estimate?lat=${lat}&lon=${lon}&radius_km=1`); const data = await response.json(); populationTooltip.innerHTML = `Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}<br>Pop. (~1km): ${data.estimated_population.toLocaleString()}`; } catch (error) { console.error("Error fetching population estimate:", error); populationTooltip.innerHTML = `Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}<br>Could not load data.`; } }
    async function simulationLoop(timestamp) { const deltaTime = (timestamp - state.lastTimestamp) / 1000; state.lastTimestamp = timestamp; if (state.isPlaying) { state.elapsedSeconds += deltaTime * state.speedMultiplier * state.direction; const data = await fetchData(); if(data) updateVisualization(data); } requestAnimationFrame(simulationLoop); }
    async function updateTLE() {
        const tleText = tleInput.value.trim();
        const lines = tleText.split('\n');

        if (lines.length !== 3) {
            alert("Invalid TLE format. Please provide 3 lines: Name, Line 1, and Line 2.");
            return;
        }

        updateTleBtn.disabled = true;
        updateTleBtn.textContent = 'Loading...';

        try {
            const response = await fetch(`${API_BASE_URL}/api/update-tle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    line1: lines[0].trim(),
                    line2: lines[1].trim(),
                    line3: lines[2].trim()
                })
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Failed to update TLE.');
            }
            
            // On success, reset everything and fetch new initial data
            alert(`Successfully loaded satellite: ${data.name}`);
            resetSimulation();
            const newData = await fetchData(); // Fetch T=0 for new satellite
            if (newData) updateVisualization(newData);

        } catch (error) {
            console.error("Error updating TLE:", error);
            alert(`Error: ${error.message}`);
        } finally {
            updateTleBtn.disabled = false;
            updateTleBtn.textContent = 'Load TLE';
        }
    }
    function updatePlayPauseButton() { playPauseBtn.textContent = state.isPlaying ? 'Pause' : 'Play'; }
    
    // Initialize and start
    initThreeJS();
    animate();
    simulationLoop(performance.now());
    
    // Event listeners
    playPauseBtn.addEventListener('click', () => { state.isPlaying = !state.isPlaying; updatePlayPauseButton(); });
    calculateScoreBtn.addEventListener('click', calculateCoverageScore);
    calculateAreaBtn.addEventListener('click', calculateCoverageArea);
    reverseBtn.addEventListener('click', () => { state.direction = -1; });
    forwardBtn.addEventListener('click', () => { state.direction = 1; });
    speedSlider.addEventListener('input', (e) => { state.speedMultiplier = Number(e.target.value); speedLabel.textContent = `${state.speedMultiplier}x`; });
    window.addEventListener('resize', handleResize);
    togglePopulationBtn.addEventListener('click', togglePopulationMap);
    calculateEconomicsBtn.addEventListener('click', calculateEconomicAnalysis);
    adoptionRateSlider.addEventListener('input', (e) => { adoptionRateLabel.textContent = `${e.target.value}%`; });
    arpuSlider.addEventListener('input', (e) => { arpuLabel.textContent = `$${e.target.value}`; });
    updateTleBtn.addEventListener('click', updateTLE);

    pinpointBtn.addEventListener('click', () => {
        const lat = parseFloat(latInput.value);
        const lon = parseFloat(lonInput.value);
        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            alert('Invalid input. Please enter a valid latitude (-90 to 90) and longitude (-180 to 180).');
            return;
        }
        placePin(lat, lon);
    });

    // Initial setup
    updatePlayPauseButton();
    speedLabel.textContent = `${state.speedMultiplier}x`;
    fetchData().then(data => { if(data) updateVisualization(data); });
});