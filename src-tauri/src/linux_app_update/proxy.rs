//! Preserve bypass rules when importing the GNOME proxy into reqwest.
pub(super) fn with_bypass(
    url: &str,
    ignored_hosts: &[String],
    no_proxy: Option<&str>,
) -> Result<reqwest::Proxy, reqwest::Error> {
    use hyper_util::client::proxy::matcher::Matcher;

    // Validate once, before installing the per-request selector.
    reqwest::Proxy::all(url)?;
    let proxy = url.to_owned();
    let mut rules = Vec::new();
    for rule in ignored_hosts {
        let rule = rule.trim().to_ascii_lowercase();
        let rule = rule.strip_prefix("*.").unwrap_or(&rule);
        // GNOME also supports host:port and [IPv6]:port exclusions.
        let (host, port) = match rule.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') || host.ends_with(']') => {
                match port.parse::<u16>() {
                    Ok(port) => (host, Some(port)),
                    Err(_) => (rule, None),
                }
            }
            _ => (rule, None),
        };
        let host = host.trim_start_matches('[').trim_end_matches(']');
        rules.push((port, Matcher::builder().all(url).no(host).build()));
    }
    if let Some(no_proxy) = no_proxy {
        rules.push((None, Matcher::builder().all(url).no(no_proxy).build()));
    }
    Ok(reqwest::Proxy::custom(move |url| {
        let uri = url.as_str().parse().ok()?;
        let bypass = rules.iter().any(|(port, matcher)| {
            port.is_none_or(|port| url.port_or_known_default() == Some(port))
                && matcher.intercept(&uri).is_none()
        });
        (!bypass).then(|| proxy.clone())
    }))
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::{SocketAddr, TcpListener},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Duration,
    };

    fn client_builder() -> reqwest::ClientBuilder {
        // The updater installs ring before creating its clients; these tests bypass it.
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
    }

    struct Server {
        address: SocketAddr,
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl Server {
        fn new(body: &'static str) -> Self {
            Self::response(format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ))
        }

        fn response(response: String) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            listener.set_nonblocking(true).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let shutdown = stop.clone();
            let thread = thread::spawn(move || {
                while !shutdown.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut request = [0; 4096];
                            stream.read(&mut request).unwrap();
                            stream.write_all(response.as_bytes()).unwrap();
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                }
            });
            Self {
                address,
                stop,
                thread: Some(thread),
            }
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.thread.take().unwrap().join().unwrap();
        }
    }

    async fn request(host: &str, ignored_hosts: &[&str], no_proxy: Option<&str>) -> String {
        let origin = Server::new("direct");
        let proxy = Server::new("proxy");
        let rules = ignored_hosts
            .iter()
            .map(|host| host.to_string())
            .collect::<Vec<_>>();
        let client = client_builder()
            // Isolate the test from the machine's own process proxy settings.
            .no_proxy()
            .proxy(
                super::with_bypass(&format!("http://{}", proxy.address), &rules, no_proxy).unwrap(),
            )
            .resolve(host, origin.address)
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        client
            .get(format!(
                "http://{host}:{}/latest.json",
                origin.address.port()
            ))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn gnome_github_bypass_applies_to_api_raw_and_downloads() {
        for host in [
            "github.com",
            "api.github.com",
            "raw.githubusercontent.com",
            "release-assets.githubusercontent.com",
        ] {
            assert_eq!(
                request(host, &["github.com", "githubusercontent.com"], None).await,
                "direct"
            );
        }
    }

    #[tokio::test]
    async fn environment_bypass_is_merged_with_gnome_rules() {
        assert_eq!(
            request("api.github.com", &["localhost"], Some("github.com")).await,
            "direct"
        );
        assert_eq!(
            request(
                "raw.githubusercontent.com",
                &["githubusercontent.com"],
                Some("github.com")
            )
            .await,
            "direct"
        );
    }

    #[tokio::test]
    async fn unmatched_hosts_still_use_the_proxy() {
        assert_eq!(
            request("notgithub.com", &["github.com"], Some("example.org")).await,
            "proxy"
        );
        assert_eq!(request("api.github.com", &[], None).await, "proxy");
    }

    #[tokio::test]
    async fn gnome_wildcard_and_port_rules() {
        assert_eq!(
            request("api.github.com", &["*.github.com"], None).await,
            "direct"
        );
        assert_eq!(
            request("api.github.com", &["github.com:443"], None).await,
            "proxy"
        );
    }

    #[tokio::test]
    async fn gnome_port_and_ip_ranges() {
        let origin = Server::new("direct");
        let proxy = Server::new("proxy");
        let rules = vec![format!("*.github.com:{}", origin.address.port())];
        let client = client_builder()
            .no_proxy()
            .proxy(super::with_bypass(&format!("http://{}", proxy.address), &rules, None).unwrap())
            .resolve("api.github.com", origin.address)
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(
            client
                .get(format!(
                    "http://api.github.com:{}/package",
                    origin.address.port()
                ))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "direct"
        );
        assert_eq!(request("127.0.0.1", &["127.0.0.0/8"], None).await, "direct");
        assert_eq!(
            request("127.0.0.1", &["192.168.0.0/16"], None).await,
            "proxy"
        );
    }

    #[tokio::test]
    async fn redirects_reselect_proxy_in_both_directions() {
        for starts_direct in [false, true] {
            let destination = Server::new("direct");
            let redirect = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://asset.example:{}/package\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                destination.address.port()
            );
            let origin = Server::response(redirect.clone());
            let proxy = Server::response(if starts_direct {
                "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy".into()
            } else {
                redirect
            });
            let rules = vec![
                if starts_direct {
                    "manifest.example"
                } else {
                    "asset.example"
                }
                .to_string(),
            ];
            let client = client_builder()
                .no_proxy()
                .proxy(
                    super::with_bypass(&format!("http://{}", proxy.address), &rules, None).unwrap(),
                )
                .resolve("manifest.example", origin.address)
                .resolve("asset.example", destination.address)
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let result = client
                .get(format!(
                    "http://manifest.example:{}/latest.json",
                    origin.address.port()
                ))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert_eq!(result, if starts_direct { "proxy" } else { "direct" });
        }
    }

    #[tokio::test]
    async fn wildcard_bypasses_all_hosts() {
        assert_eq!(request("api.github.com", &[], Some("*")).await, "direct");
    }
}
